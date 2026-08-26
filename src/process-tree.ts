import { execFileSync } from "node:child_process";
import { readProcessStartToken } from "./recovery.ts";

export interface ProcessIdentity {
  pid: number;
  processStartToken: string;
  depth: number;
}

interface ProcessTreeDeps {
  listProcesses?: () => string;
  readStartToken?: (pid: number) => string | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

function listProcesses(): string {
  return execFileSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
}

/** Take one parent-chain snapshot before the PTY leader can exit and lose its
 * descendants to init or a subreaper. Every PID is bound to its process start
 * identity so later signals cannot target a reused PID. */
export function snapshotDescendantProcesses(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): ProcessIdentity[] {
  const output = (deps.listProcesses ?? listProcesses)();
  const readStartToken = deps.readStartToken ?? readProcessStartToken;
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = (children.get(rootPid) ?? []).map((pid) => ({ pid, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    const processStartToken = readStartToken(current.pid);
    if (processStartToken !== null) {
      descendants.push({ ...current, processStartToken });
    }
    for (const pid of children.get(current.pid) ?? []) {
      queue.push({ pid, depth: current.depth + 1 });
    }
  }
  return descendants.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
}

function isSameProcess(
  identity: ProcessIdentity,
  readStartToken: (pid: number) => string | null,
): boolean {
  return readStartToken(identity.pid) === identity.processStartToken;
}

/** Signal only identities that still match their snapshot. A token mismatch
 * means the original process exited and the PID may now belong to anything. */
export function signalProcessIdentities(
  identities: ProcessIdentity[],
  signal: NodeJS.Signals,
  deps: ProcessTreeDeps = {},
): number[] {
  const readStartToken = deps.readStartToken ?? readProcessStartToken;
  const sendSignal = deps.signal ?? ((pid, value) => process.kill(pid, value));
  const signalled: number[] = [];
  for (const identity of identities) {
    if (!isSameProcess(identity, readStartToken)) continue;
    try {
      sendSignal(identity.pid, signal);
      signalled.push(identity.pid);
    } catch {}
  }
  return signalled;
}

async function waitForIdentitiesToExit(
  identities: ProcessIdentity[],
  timeoutMs: number,
  deps: ProcessTreeDeps,
): Promise<ProcessIdentity[]> {
  const readStartToken = deps.readStartToken ?? readProcessStartToken;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let survivors = identities.filter((identity) => isSameProcess(identity, readStartToken));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(25);
    survivors = survivors.filter((identity) => isSameProcess(identity, readStartToken));
  }
  return survivors;
}

/** Stop an exact descendant snapshot without a process-group signal. TERM
 * gives cooperative servers time to release sockets. KILL is a bounded
 * backstop for descendants that ignore TERM. */
export async function terminateProcessIdentities(
  identities: ProcessIdentity[],
  options: { termWaitMs?: number; killWaitMs?: number } = {},
  deps: ProcessTreeDeps = {},
): Promise<ProcessIdentity[]> {
  if (identities.length === 0) return [];
  signalProcessIdentities(identities, "SIGTERM", deps);
  const afterTerm = await waitForIdentitiesToExit(
    identities,
    options.termWaitMs ?? 1_500,
    deps,
  );
  if (afterTerm.length === 0) return [];
  signalProcessIdentities(afterTerm, "SIGKILL", deps);
  return waitForIdentitiesToExit(afterTerm, options.killWaitMs ?? 500, deps);
}
