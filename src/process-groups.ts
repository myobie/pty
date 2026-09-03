/** Finishing a kill that the daemon could not finish.
 *
 * The daemon tears the child's tree down on its way out, so the teardown races
 * its own exit. The command outlives the daemon, which puts it in the only
 * position from which the job can be completed.
 *
 * Groups rather than pids, because a group signal needs no per-process
 * identity. `snapshotDescendantProcesses` drops a descendant whose start token
 * cannot be read and never signals it; a group reaches it anyway. The sweep is
 * also cheaper — reading start tokens costs one `ps` per descendant on macOS,
 * and a sweep costs one `ps` in total.
 */

import { execFileSync } from "node:child_process";

/** One row of `ps -axo pid=,ppid=,pgid=,stat=`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Process state. `ps` lists a zombie with its process group, so without
   *  this the sweep counts a corpse as a member and reports a group it has
   *  already emptied. Measured on Linux 2026-09-03: `<pid> <ppid> <pgid> Z`. */
  state: string;
}

export function isZombie(row: ProcessRow): boolean {
  return row.state.startsWith("Z");
}

export function listProcessesWithGroups(): string {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
  } catch {
    return "";
  }
}

export function parseRows(listing: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of listing.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields.length > 4) continue;
    const [pid, ppid, pgid] = fields.map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid, ppid, pgid, state: fields[3] ?? "" });
  }
  return rows;
}

/** Every distinct process group inside `rootPid`'s tree.
 *
 *  The root's own group is excluded. A pty child calls `setsid`, so the daemon
 *  sits alone in its group and signalling it would reach the daemon and nothing
 *  else. Measured on Linux, both tools, 2026-09-03.
 *
 *  Deliberately not filtered by start token: that is the whole point.
 */
export function groupsInTree(rootPid: number, rows: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  const pgidOf = new Map<number, number>();
  for (const r of rows) {
    children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
    pgidOf.set(r.pid, r.pgid);
  }
  const rootGroup = pgidOf.get(rootPid);
  const groups: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const g = pgidOf.get(pid);
    if (g !== undefined && g !== rootGroup && g > 1 && !groups.includes(g)) groups.push(g);
    for (const c of children.get(pid) ?? []) queue.push(c);
  }
  return groups.sort((a, b) => a - b);
}

/** The live pids that still belong to any of `groups`. A zombie is excluded:
 *  `ps` still lists it with its group, and counting it would make the sweep
 *  report a group it has already emptied. */
export function membersOfGroups(groups: number[], rows: ProcessRow[]): number[] {
  return rows
    .filter((r) => !isZombie(r) && groups.includes(r.pgid))
    .map((r) => r.pid)
    .sort((a, b) => a - b);
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1) return;
  // A negative pid is the documented way to signal a process group.
  try { process.kill(-pgid, signal); } catch {}
}

export function ownProcessGroup(): number {
  // `pgid` of self. Node has no getpgrp binding, so ask ps about our own pid.
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    const n = Number(out);
    return Number.isInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

export interface SweepDeps {
  live: (groups: number[]) => number[];
  signal: (pgid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

/** TERM every group, wait, KILL what is left, wait, then say what is STILL
 *  there. The caller reports the return value; it never reports the sending.
 *
 *  `ownGroup` is skipped so the command survives to print its own result.
 */
export async function sweepGroups(
  groups: number[],
  ownGroup: number,
  termWaitMs: number,
  killWaitMs: number,
  deps: SweepDeps,
): Promise<number[]> {
  const targets = groups.filter((g) => g > 1 && g !== ownGroup);
  if (targets.length === 0) return deps.live(groups);

  for (const g of targets) deps.signal(g, "SIGTERM");
  let remaining = await waitFor(targets, termWaitMs, deps);
  if (remaining.length === 0) return [];

  for (const g of targets) deps.signal(g, "SIGKILL");
  remaining = await waitFor(targets, killWaitMs, deps);
  return remaining;
}

async function waitFor(targets: number[], budgetMs: number, deps: SweepDeps): Promise<number[]> {
  const deadline = Date.now() + budgetMs;
  let remaining = deps.live(targets);
  while (remaining.length > 0 && Date.now() < deadline) {
    await deps.sleep(25);
    remaining = deps.live(targets);
  }
  return remaining;
}
