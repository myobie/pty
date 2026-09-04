import { describe, expect, it } from "vitest";
import {
  signalProcessIdentities,
  snapshotDescendantProcesses,
  terminateProcessIdentities,
  type ProcessIdentity,
} from "../src/process-tree.ts";
import {
  liveIdentity,
  sourceFromShape,
  valueOf,
  type ProcessSource,
} from "../src/proc-table.ts";

/** A source whose identities can change under the test, so a reused PID can be
 *  simulated without touching a real machine. */
function mutableSource(live: Map<number, string>, shape: string): () => ProcessSource {
  const base = sourceFromShape(shape);
  const rowOf = (pid: number) => {
    const v = live.get(pid);
    if (v === undefined) return null;
    const row = valueOf(base.row(pid));
    return row ? { ...row, identity: liveIdentity(v) } : null;
  };
  return () => ({
    rows: () => base.rows(),
    row: (pid) => {
      const r = rowOf(pid);
      return r === null
        ? { kind: "not-present" as const }
        : { kind: "known" as const, value: r };
    },
    isRunning: (pid) => {
      const r = rowOf(pid);
      return r === null
        ? { kind: "not-present" as const }
        : { kind: "known" as const, value: true };
    },
    identity: (pid) => {
      const r = rowOf(pid);
      return r === null || r.identity === null
        ? { kind: "not-present" as const }
        : { kind: "known" as const, value: r.identity };
    },
  });
}

describe("exact descendant process shutdown", () => {
  it("snapshots only descendants and records depth plus process-start identity", () => {
    // 10 is the root; 14 hangs off an unrelated parent and must not appear.
    const snapshot = snapshotDescendantProcesses(10, {
      source: () =>
        sourceFromShape(
          [
            "10 1 10 Ss start-10",
            "11 10 10 S start-11",
            "12 11 10 S start-12",
            "13 10 10 S start-13",
            "14 99 99 S start-14",
          ].join("\n"),
        ),
    });

    expect(snapshot).toEqual([
      { pid: 12, identity: liveIdentity("start-12"), depth: 2 },
      { pid: 13, identity: liveIdentity("start-13"), depth: 1 },
      { pid: 11, identity: liveIdentity("start-11"), depth: 1 },
    ]);
  });

  it("never signals a PID whose process-start identity changed", () => {
    const identities: ProcessIdentity[] = [
      { pid: 20, identity: liveIdentity("original-20"), depth: 1 },
      { pid: 21, identity: liveIdentity("original-21"), depth: 1 },
    ];
    const signals: Array<[number, NodeJS.Signals]> = [];
    // 20 has been reused by something else; 21 is still itself.
    const live = new Map([[20, "reused-20"], [21, "original-21"]]);

    const signalled = signalProcessIdentities(identities, "SIGTERM", {
      source: mutableSource(live, "20 1 20\n21 1 21"),
      signal: (pid, signal) => { signals.push([pid, signal]); },
    });

    expect(signalled).toEqual([21]);
    expect(signals).toEqual([[21, "SIGTERM"]]);
  });

  it("uses exact TERM then exact KILL without a process-group signal", async () => {
    const identities: ProcessIdentity[] = [
      { pid: 30, identity: liveIdentity("start-30"), depth: 2 },
      { pid: 31, identity: liveIdentity("start-31"), depth: 1 },
    ];
    const live = new Map([[30, "start-30"], [31, "start-31"]]);
    const signals: Array<[number, NodeJS.Signals]> = [];

    const survivors = await terminateProcessIdentities(
      identities,
      { termWaitMs: 0, killWaitMs: 1 },
      {
        source: mutableSource(live, "30 1 30\n31 1 31"),
        signal: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === "SIGKILL") live.delete(pid);
        },
        sleep: async () => {},
      },
    );

    expect(survivors).toEqual([]);
    expect(signals).toEqual([
      [30, "SIGTERM"],
      [31, "SIGTERM"],
      [30, "SIGKILL"],
      [31, "SIGKILL"],
    ]);
    expect(signals.every(([pid]) => pid > 0)).toBe(true);
  });
});
