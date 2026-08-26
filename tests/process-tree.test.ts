import { describe, expect, it } from "vitest";
import {
  signalProcessIdentities,
  snapshotDescendantProcesses,
  terminateProcessIdentities,
  type ProcessIdentity,
} from "../src/process-tree.ts";

describe("exact descendant process shutdown", () => {
  it("snapshots only descendants and records depth plus process-start identity", () => {
    const tokens = new Map([
      [11, "start-11"],
      [12, "start-12"],
      [13, "start-13"],
    ]);
    const snapshot = snapshotDescendantProcesses(10, {
      listProcesses: () => [
        "10 1",
        "11 10",
        "12 11",
        "13 10",
        "14 99",
      ].join("\n"),
      readStartToken: (pid) => tokens.get(pid) ?? null,
    });

    expect(snapshot).toEqual([
      { pid: 12, processStartToken: "start-12", depth: 2 },
      { pid: 13, processStartToken: "start-13", depth: 1 },
      { pid: 11, processStartToken: "start-11", depth: 1 },
    ]);
  });

  it("never signals a PID whose process-start identity changed", () => {
    const identities: ProcessIdentity[] = [
      { pid: 20, processStartToken: "original-20", depth: 1 },
      { pid: 21, processStartToken: "original-21", depth: 1 },
    ];
    const signals: Array<[number, NodeJS.Signals]> = [];

    const signalled = signalProcessIdentities(identities, "SIGTERM", {
      readStartToken: (pid) => pid === 20 ? "reused-20" : "original-21",
      signal: (pid, signal) => { signals.push([pid, signal]); },
    });

    expect(signalled).toEqual([21]);
    expect(signals).toEqual([[21, "SIGTERM"]]);
  });

  it("uses exact TERM then exact KILL without a process-group signal", async () => {
    const identities: ProcessIdentity[] = [
      { pid: 30, processStartToken: "start-30", depth: 2 },
      { pid: 31, processStartToken: "start-31", depth: 1 },
    ];
    const live = new Map(identities.map((identity) => [identity.pid, identity.processStartToken]));
    const signals: Array<[number, NodeJS.Signals]> = [];

    const survivors = await terminateProcessIdentities(
      identities,
      { termWaitMs: 0, killWaitMs: 1 },
      {
        readStartToken: (pid) => live.get(pid) ?? null,
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
