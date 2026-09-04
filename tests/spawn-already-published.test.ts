// A `pty run` that loses a creation race waited out the whole 30 second start
// budget and then reported a generic publication timeout, when the true answer
// was on disk in the first pass.
//
// The safety property was never in question: exactly one process wins. What was
// wrong is what the loser said, and how long it took to say it.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { publishedElsewhere } from "../src/spawn.ts";
import { hasProcessExitedForReap, isProcessAlive } from "../src/sessions.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("deciding that somebody else owns the name", () => {
  const live = () => true;
  const dead = () => false;
  const yes = () => true;
  const no = () => false;

  // Every way of answering "no", so the one way of answering "yes" means
  // something. Raced for, only the last of these would ever be exercised.
  it("needs a live, different, published owner", () => {
    expect(publishedElsewhere(200, 100, live, yes)).toBe(true);
  });

  it("does not count our own pid as somebody else", () => {
    expect(publishedElsewhere(100, 100, live, yes)).toBe(false);
  });

  it("does not count a dead owner, which would make the name unusable forever", () => {
    expect(publishedElsewhere(200, 100, dead, yes)).toBe(false);
  });

  it("does not count metadata that is still being written", () => {
    expect(publishedElsewhere(200, 100, live, no)).toBe(false);
  });

  it("does not count a missing owner", () => {
    expect(publishedElsewhere(null, 100, live, yes)).toBe(false);
  });

  // The predicate the production path actually passes, against a real corpse.
  // `isProcessAlive` says true for a zombie, which would refuse the name for as
  // long as the corpse went unreaped. An unreaped daemon is the precise case.
  it("does not count a zombie daemon as a live owner", async () => {
    const sh = spawn("sh", ["-c", "sleep 0.1 & echo $! ; kill -STOP $$"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const corpse = await new Promise<number>((resolve) =>
        sh.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
      );
      for (let i = 0; i < 500 && !hasProcessExitedForReap(corpse); i++) await sleep(10);

      expect(isProcessAlive(corpse), "precondition: a zombie answers kill(pid, 0)").toBe(true);
      const ownerLive = (pid: number) => !hasProcessExitedForReap(pid);
      expect(
        publishedElsewhere(corpse, 100, ownerLive, yes),
        "a zombie daemon must not make the session name unusable",
      ).toBe(false);
    } finally {
      sh.kill("SIGKILL");
    }
  }, 20_000);
});
