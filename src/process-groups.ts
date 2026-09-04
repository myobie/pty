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

import {
  isZombie,
  openSource,
  valueOf,
  type ProcessSource,
  type Row,
} from "./proc-table.ts";
import { walkTree } from "./process-tree.ts";

export type { Row as ProcessRow } from "./proc-table.ts";
export { openSource } from "./proc-table.ts";

/** Every distinct process group inside `rootPid`'s tree.
 *
 *  The root's own group is excluded. A pty child calls `setsid`, so the daemon
 *  sits alone in its group and signalling it would reach the daemon and nothing
 *  else. Measured on Linux, both tools, 2026-09-03.
 *
 *  Deliberately not filtered by start token: that is the whole point.
 */
export function groupsInTree(rootPid: number, source: ProcessSource): number[] {
  const rows = valueOf(source.rows()) ?? ([] as Row[]);
  const pgidOf = new Map<number, number>(rows.map((r) => [r.pid, r.pgid]));
  const rootGroup = pgidOf.get(rootPid);
  const groups: number[] = [];
  for (const { pid } of walkTree(rootPid, source)) {
    const g = pgidOf.get(pid);
    if (g !== undefined && g !== rootGroup && g > 1 && !groups.includes(g)) groups.push(g);
  }
  return groups.sort((a, b) => a - b);
}

/** The live pids that still belong to any of `groups`. A zombie is excluded:
 *  `ps` still lists it with its group, and counting it would make the sweep
 *  report a group it has already emptied. */
export function membersOfGroups(groups: number[], source: ProcessSource): number[] {
  const rows = valueOf(source.rows()) ?? ([] as Row[]);
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

export function ownProcessGroup(source: ProcessSource = openSource()): number {
  // Node has no `getpgrp` binding, so this comes out of the table like every
  // other process fact. On Linux that is a `/proc` read and no subprocess.
  const row = valueOf(source.row(process.pid));
  return row ? row.pgid : -1;
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
