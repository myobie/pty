import {
  openSource,
  valueOf,
  type LiveIdentity,
  type ProcessSource,
  type Row,
} from "./proc-table.ts";

export interface ProcessIdentity {
  pid: number;
  /** Proof of identity for the length of one command. Not the registry's
   *  `recovery.processStartToken`: see `proc-table.ts`. */
  identity: LiveIdentity;
  depth: number;
}

interface ProcessTreeDeps {
  /** Where process facts come from. Defaults to one source per iteration,
   *  which on Linux reads `/proc` and on macOS is one `ps` call. */
  source?: () => ProcessSource;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Take one parent-chain snapshot before the PTY leader can exit and lose its
 * descendants to init or a subreaper. Every PID is bound to its process start
 * identity so later signals cannot target a reused PID. */
export function snapshotDescendantProcesses(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): ProcessIdentity[] {
  const source = (deps.source ?? openSource)();
  const descendants: ProcessIdentity[] = [];
  for (const { pid, depth } of walkTree(rootPid, source)) {
    const identity = valueOf(source.identity(pid));
    if (identity !== null) descendants.push({ pid, identity, depth });
  }
  return descendants.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
}

/** Walk a tree from `rootPid`, breadth first, recording depth. */
export function walkTree(
  rootPid: number,
  source: ProcessSource,
): Array<{ pid: number; depth: number }> {
  const rows = valueOf(source.rows()) ?? ([] as Row[]);
  const children = new Map<number, number[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  const out: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue = (children.get(rootPid) ?? []).map((pid) => ({ pid, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    out.push(current);
    for (const pid of children.get(current.pid) ?? []) {
      queue.push({ pid, depth: current.depth + 1 });
    }
  }
  return out;
}

/** Is this still the same process?
 *
 *  **An unreadable source answers false, and that is deliberate**: it says
 *  "do not signal", never "it is gone". Every caller here wants the safe
 *  direction for a signal. */
function isSameProcess(identity: ProcessIdentity, source: ProcessSource): boolean {
  return valueOf(source.identity(identity.pid)) === identity.identity;
}

/** Signal only identities that still match their snapshot. A token mismatch
 * means the original process exited and the PID may now belong to anything. */
export function signalProcessIdentities(
  identities: ProcessIdentity[],
  signal: NodeJS.Signals,
  deps: ProcessTreeDeps = {},
): number[] {
  const source = (deps.source ?? openSource)();
  const sendSignal = deps.signal ?? ((pid, value) => process.kill(pid, value));
  const signalled: number[] = [];
  for (const identity of identities) {
    if (!isSameProcess(identity, source)) continue;
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
  const openIteration = deps.source ?? openSource;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  // **One source per iteration, not one question per process.** On macOS every
  // question used to be a `ps` spawn: at 25 ms polling inside a 1500 ms budget,
  // four descendants cost 240 spawns, and at the 10.9 ms a spawn was measured to
  // take that is 2.6 seconds of spawning inside a 1.5 second deadline. The loop
  // could not meet its own deadline on an idle machine. It is now one `ps` per
  // iteration there, and no subprocess at all on Linux.
  let source = openIteration();
  let survivors = identities.filter((identity) => isSameProcess(identity, source));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(25);
    source = openIteration();
    survivors = survivors.filter((identity) => isSameProcess(identity, source));
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
