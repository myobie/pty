/** What `pty kill` may claim, and how it says it.
 *
 * The command signals the daemon and waits for that one PID. The child, and
 * everything the child started, is a separate question. This module answers it
 * from a snapshot taken before the signal, and turns the answer into the lines
 * the command prints.
 *
 * Kept out of `cli.ts` because that module runs `main()` on import and cannot
 * be loaded by a test.
 */

import type { ProcessIdentity } from "./process-tree.ts";

/** What the pre-kill snapshot looks like once the daemon has gone. */
export interface Aftermath {
  /** The start token still matches, so this is the same process and it is
   *  still running. */
  survived: number[];
  /** The PID has not exited but its start token could not be read. We cannot
   *  tell whether it is the same process or a PID the kernel has reused.
   *
   *  This case gets its own list rather than joining either side. Folding it
   *  into `survived` would invent a survivor; dropping it would repeat the
   *  defect this module exists to remove, which is a failure to measure
   *  reported as an answer. */
  unknown: number[];
}

export function allGone(after: Aftermath): boolean {
  return after.survived.length === 0 && after.unknown.length === 0;
}

/** Did the command verify that nothing is left?
 *
 *  **Both halves are required.** `Aftermath` only describes the processes that
 *  were in the pre-kill snapshot, and the snapshot drops anything whose start
 *  token could not be read. A process the sweep found and could not kill may
 *  therefore be absent from `after` entirely. Reading `after` alone would print
 *  the success line over a process that just survived SIGKILL, which is the
 *  defect this command exists to stop making.
 */
export function verifiedEmpty(after: Aftermath, escalated?: number[]): boolean {
  return allGone(after) && (escalated === undefined || escalated.length === 0);
}

/** Re-check a snapshot against the live process table.
 *
 *  `exited` must be `hasProcessExitedForReap`, not `!isProcessAlive`. A zombie
 *  answers `kill(pid, 0)` and keeps a readable start token, so the two cheaper
 *  predicates both call it a survivor. It is a dead process waiting to be
 *  reaped, and reporting it as still running would be this command
 *  over-claiming again, only in the other direction.
 */
export function aftermathOf(
  before: ProcessIdentity[],
  readStartToken: (pid: number) => string | null,
  exited: (pid: number) => boolean,
): Aftermath {
  const after: Aftermath = { survived: [], unknown: [] };
  for (const identity of before) {
    if (exited(identity.pid)) continue;
    const token = readStartToken(identity.pid);
    if (token === identity.processStartToken) after.survived.push(identity.pid);
    // A different token is a PID the kernel handed to somebody else.
    else if (token === null) after.unknown.push(identity.pid);
  }
  return after;
}

/** Say what was verified, and nothing more.
 *
 *  `killed` is a claim about the whole tree, so it appears only when every
 *  process in the snapshot is gone. Otherwise standard output carries the part
 *  that was verified — the daemon stopped — and standard error carries what
 *  survived it. The two never appear together, so a reader who greps for the
 *  success line cannot find it beside a warning that contradicts it.
 */
export function killOutcomeLines(
  name: string,
  after: Aftermath,
  /** Pids still alive after the escalation swept the session's process groups,
   *  or undefined when no escalation ran. An empty array means it ran and
   *  cleared everything. */
  escalated?: number[],
): { out: string[]; err: string[] } {
  if (verifiedEmpty(after, escalated)) {
    // Say when the escalation was needed. A silent success would hide that the
    // daemon's teardown left something behind, which is the fact somebody
    // debugging this wants.
    const line = escalated
      ? `Session "${name}" killed (the escalation stopped the remainder).`
      : `Session "${name}" killed.`;
    return { out: [line], err: [] };
  }
  const err: string[] = [];
  if (escalated && escalated.length > 0) {
    err.push(
      `Session "${name}": ${escalated.length} process(es) survived SIGKILL to ` +
      `their process group: ${escalated.join(", ")}`,
    );
  }
  if (after.survived.length > 0) {
    err.push(
      `Session "${name}": ${after.survived.length} process(es) survived the kill ` +
      `and are still running: ${after.survived.join(", ")}`,
    );
  }
  if (after.unknown.length > 0) {
    err.push(
      `Session "${name}": ${after.unknown.length} process(es) may still be running: ` +
      `${after.unknown.join(", ")}. Their start tokens could not be read, so this ` +
      "is not a conclusion.",
    );
  }
  return { out: [`Session "${name}" daemon stopped.`], err };
}
