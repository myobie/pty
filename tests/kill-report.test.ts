// `pty kill` used to ask about the daemon and report about the session. These
// tests hold the replacement to the narrower claim: a process is called a
// survivor only when it was measured as one.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  aftermathOf,
  allGone,
  killOutcomeLines,
  type Aftermath,
} from "../src/kill-report.ts";
import { hasProcessExitedForReap, reapedFromPsState } from "../src/sessions.ts";
import { readProcessStartToken } from "../src/recovery.ts";
import type { ProcessIdentity } from "../src/process-tree.ts";

const identity = (pid: number, token: string): ProcessIdentity => ({
  pid,
  processStartToken: token,
  depth: 1,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("classifying a pre-kill snapshot", () => {
  it("calls a matching start token a survivor", () => {
    const after = aftermathOf([identity(10, "tok:10")], () => "tok:10", () => false);
    expect(after.survived).toEqual([10]);
    expect(after.unknown).toEqual([]);
    expect(allGone(after)).toBe(false);
  });

  it("does not call a reused PID a survivor", () => {
    const after = aftermathOf([identity(10, "tok:10")], () => "tok:other", () => false);
    expect(allGone(after)).toBe(true);
  });

  it("does not report a process that exited", () => {
    const after = aftermathOf([identity(10, "tok:10")], () => null, () => true);
    expect(allGone(after)).toBe(true);
  });

  // The whole point of the third list: a PID we can see but cannot identify is
  // reported as undecided, never silently as dead.
  it("reports a live PID with an unreadable token as undecided", () => {
    const after = aftermathOf([identity(10, "tok:10")], () => null, () => false);
    expect(after.survived).toEqual([]);
    expect(after.unknown).toEqual([10]);
    expect(allGone(after)).toBe(false);
  });

  it("treats an empty snapshot as nothing to report", () => {
    expect(allGone(aftermathOf([], () => null, () => false))).toBe(true);
  });
});

describe("classifying against the real process table", () => {
  // The mocked cases prove the branching. This one proves the branching is
  // about real processes.
  it("sees a running process, then stops seeing it", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid!;
    const token = readProcessStartToken(pid);
    expect(token).not.toBeNull();
    const before = [identity(pid, token!)];

    expect(aftermathOf(before, readProcessStartToken, hasProcessExitedForReap).survived)
      .toEqual([pid]);

    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    await sleep(50);

    expect(allGone(aftermathOf(before, readProcessStartToken, hasProcessExitedForReap)))
      .toBe(true);
  });

  // A zombie answers kill(pid, 0) and keeps a readable start token, so the two
  // obvious predicates both call it alive. Reporting it as a surviving process
  // would be a false alarm. The shell below backgrounds a short sleep and then
  // stops itself, so it cannot reap the child.
  it("does not call a real zombie a survivor", async () => {
    const sh = spawn("sh", ["-c", "sleep 0.1 & echo $! ; kill -STOP $$"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const pid = await new Promise<number>((resolve) =>
        sh.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
      );
      const token = readProcessStartToken(pid);
      expect(token).not.toBeNull();
      const before = [identity(pid, token!)];

      // Wait for it to become a zombie rather than assuming the timing.
      for (let i = 0; i < 100 && !hasProcessExitedForReap(pid); i++) await sleep(10);

      expect(hasProcessExitedForReap(pid)).toBe(true);
      expect(readProcessStartToken(pid)).toBe(token);
      expect(allGone(aftermathOf(before, readProcessStartToken, hasProcessExitedForReap)))
        .toBe(true);
    } finally {
      sh.kill("SIGKILL");
    }
  });
});

describe("an empty ps state field", () => {
  // An empty field is two answers wearing one shape. Reading it as "gone" is a
  // failure folded into an answer about what is there.
  it("asks the kernel again instead of reading silence as death", () => {
    expect(reapedFromPsState("", () => true)).toBe(false);
    expect(reapedFromPsState("", () => false)).toBe(true);
  });

  it("still reads an explicit zombie state as exited", () => {
    expect(reapedFromPsState("Z", () => true)).toBe(true);
    expect(reapedFromPsState("Z+", () => true)).toBe(true);
  });

  it("does not call a running process exited", () => {
    expect(reapedFromPsState("S", () => true)).toBe(false);
    expect(reapedFromPsState("S+", () => false)).toBe(false);
  });
});

describe("what the command prints", () => {
  const clean: Aftermath = { survived: [], unknown: [] };

  it("says killed only when the whole tree is gone", () => {
    expect(killOutcomeLines("s", clean)).toEqual({
      out: ['Session "s" killed.'],
      err: [],
    });
  });

  it("claims only the daemon when something survived", () => {
    const lines = killOutcomeLines("s", { survived: [42, 43], unknown: [] });
    expect(lines.out).toEqual(['Session "s" daemon stopped.']);
    expect(lines.err[0]).toContain("2 process(es) survived");
    expect(lines.err[0]).toContain("42, 43");
  });

  it("names an undecided process without deciding", () => {
    const lines = killOutcomeLines("s", { survived: [], unknown: [7] });
    expect(lines.out).toEqual(['Session "s" daemon stopped.']);
    expect(lines.err[0]).toContain("may still be running");
    expect(lines.err[0]).toContain("is not a conclusion");
  });

  // A reader who greps for the success line must not find it beside a warning
  // that contradicts it.
  it("never prints the success line next to a survivor report", () => {
    for (const after of [
      clean,
      { survived: [1], unknown: [] },
      { survived: [], unknown: [2] },
      { survived: [1], unknown: [2] },
    ]) {
      const { out, err } = killOutcomeLines("s", after);
      const claimedKilled = out.some((l) => l.includes("killed."));
      expect(claimedKilled && err.length > 0).toBe(false);
    }
  });
});
