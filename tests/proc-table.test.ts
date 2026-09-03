// One reader for the process table. These tests are about the three answers
// and about a `ps` that misbehaves, because that is what produced the wrong
// answers this module exists to stop.

import { describe, expect, it } from "vitest";
import {
  isDefinitelyAbsent,
  isZombie,
  openSource,
  orAbsentWhenUnknown,
  parseProcStat,
  parsePsListing,
  sourceFromShape,
  unknown,
  valueOf,
} from "../src/proc-table.ts";
import { spawn } from "node:child_process";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const me = process.pid;

describe("the truncation guard", () => {
  // `ps` always lists at least the process that ran it. A listing without our
  // own pid was truncated or never produced, and reading it as "the machine
  // has no processes" is the defect this whole module exists for.
  it("treats a listing without our own pid as unreadable, not empty", () => {
    expect(parsePsListing("4242 1 4242 S 100 0.0 Wed Sep  3 11:00:00 2026\n")).toBeNull();
  });

  it("treats an empty listing as unreadable, not empty", () => {
    expect(parsePsListing("")).toBeNull();
    expect(parsePsListing("   \n\n")).toBeNull();
  });

  it("accepts a listing that contains us", () => {
    const rows = parsePsListing(`${me} 1 ${me} S 100 0.5 Wed Sep  3 11:00:00 2026\n`);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({ pid: me, ppid: 1, pgid: me, rssKb: 100, cpuPercent: 0.5 });
  });

  // `ps -o lstart=` pads a single-digit day with two spaces, and that text is
  // the registry's on-disk token. Re-joining split fields would rewrite it.
  it("keeps the lstart text exactly as ps printed it", () => {
    const rows = parsePsListing(`${me} 1 ${me} S 100 0.5 Wed Sep  3 11:00:00 2026\n`);
    expect(rows![0].identity).toBe("darwin:Wed Sep  3 11:00:00 2026");
  });
});

describe("three answers, never two", () => {
  const source = sourceFromShape(`${me} 1 ${me} Ss`);

  it("separates a missing process from an unreadable table", () => {
    expect(isDefinitelyAbsent(source.isRunning(999_999))).toBe(true);
    expect(isDefinitelyAbsent(unknown<boolean>("table-unreadable"))).toBe(false);
  });

  it("makes treating silence as death something you have to ask for by name", () => {
    const silent = unknown<boolean>("table-unreadable");
    expect(isDefinitelyAbsent(silent)).toBe(false);
    expect(isDefinitelyAbsent(orAbsentWhenUnknown(silent))).toBe(true);
  });

  // An empty column is its own answer too: the process is there, `ps` just did
  // not say. This is the defect that shipped in `hasProcessExitedForReap`.
  it("does not turn an unnamed process into an absent one", () => {
    const unnamed = sourceFromShape(`${me} 1 ${me} Ss -`);
    const answer = unnamed.identity(me);
    expect(answer.kind).toBe("unknown");
    expect(isDefinitelyAbsent(answer)).toBe(false);
  });
});

describe("parsing /proc/<pid>/stat", () => {
  // Field 2 is the comm in parentheses and may contain spaces and brackets.
  it("reads relative to the last close paren", () => {
    const row = parseProcStat(7, `7 (a b) c) S 3 5 ${Array.from({ length: 40 }, (_, i) => i).join(" ")}`);
    expect(row).not.toBeNull();
    expect(row!.ppid).toBe(3);
    expect(row!.pgid).toBe(5);
    expect(row!.state).toBe("S");
  });

  it("returns null rather than guessing at a short line", () => {
    expect(parseProcStat(7, "7 (x) S 1 2")).toBeNull();
    expect(parseProcStat(7, "no parens here")).toBeNull();
  });
});

describe("against the real machine", () => {
  it("knows this very process", () => {
    const source = openSource();
    const row = valueOf(source.row(me));
    expect(row).not.toBeNull();
    expect(row!.pid).toBe(me);
    expect(row!.ppid).toBeGreaterThan(0);
    expect(valueOf(source.isRunning(me))).toBe(true);
    expect(valueOf(source.identity(me))).toBeTruthy();
  });

  it("calls a pid that cannot exist definitely absent", () => {
    expect(isDefinitelyAbsent(openSource().isRunning(0x7fffffff))).toBe(true);
  });

  // A zombie has a row and answers kill(pid, 0). The table must still say it
  // is not running, and must not say it is absent.
  it("reports a real zombie as present but not running", async () => {
    const sh = spawn("sh", ["-c", "sleep 0.1 & echo $! ; kill -STOP $$"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const pid = await new Promise<number>((resolve) =>
        sh.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
      );
      let source = openSource();
      for (let i = 0; i < 200; i++) {
        source = openSource();
        const row = valueOf(source.row(pid));
        if (row && isZombie(row)) break;
        await sleep(10);
      }
      const row = valueOf(source.row(pid));
      expect(row, "the child never appeared as a zombie").not.toBeNull();
      expect(isZombie(row!)).toBe(true);
      expect(valueOf(source.isRunning(pid))).toBe(false);
      expect(isDefinitelyAbsent(source.isRunning(pid))).toBe(false);
    } finally {
      sh.kill("SIGKILL");
    }
  }, 20_000);
});
