// `keep=true` buys a DEAD session a bounded retention window against `pty gc`,
// not immortality. Agents tag a session they are debugging right now and never
// come back to untag it, so an unbounded exemption turns the registry into an
// append-only log (740 of 911 sessions on one host).
//
// The policy pinned here: exempt while the session has been dead for less than
// `--keep-max-age` (default 7d), swept and reported separately once past it,
// `0` sweeps the whole backlog, and a RUNNING keep session is never a
// candidate no matter what the flag says.
//
// Sessions are fabricated on disk rather than spawned: the policy is a
// comparison against `exitedAt`/`createdAt`, so writing the record directly is
// both exact about age and free of daemon-startup waits.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const cliPath = path.join(__dirname, "..", "dist", "cli.js");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pty-gc-keep-"));
afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

let sessionDirs: string[] = [];

function makeSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(testRoot, "d-"));
  sessionDirs.push(dir);
  return dir;
}

let nameCounter = 0;
function uniqueName(): string {
  return `keep${++nameCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function runCli(sessionDir: string, ...args: string[]) {
  return spawnSync(nodeBin, [cliPath, ...args], {
    env: { ...process.env, PTY_SESSION_DIR: sessionDir },
    encoding: "utf-8",
    timeout: 10000,
  });
}

/** Metadata of a cleanly-exited session, dead for `deadForMs`. Tagged `keep`
 *  unless `tags` says otherwise. */
function writeExitedKeep(
  sessionDir: string,
  name: string,
  deadForMs: number,
  tags: Record<string, string> = { keep: "true" },
): string {
  const metaPath = path.join(sessionDir, `${name}.json`);
  const exitedAt = new Date(Date.now() - deadForMs).toISOString();
  fs.writeFileSync(metaPath, JSON.stringify({
    command: "cat",
    args: [],
    displayCommand: "cat",
    cwd: os.tmpdir(),
    createdAt: exitedAt,
    exitedAt,
    exitCode: 0,
    tags,
  }));
  return metaPath;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface ListedSession {
  name: string;
  status: string;
}

function listSessionStatus(sessionDir: string, name: string): string | undefined {
  const r = runCli(sessionDir, "list", "--json");
  expect(r.status, r.stderr).toBe(0);
  const parsed: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) return undefined;
  const sessions = parsed as ListedSession[];
  return sessions.find((s) => s.name === name)?.status;
}

afterEach(() => {
  for (const dir of sessionDirs) {
    try {
      for (const e of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, e)); } catch {} }
    } catch {}
  }
  sessionDirs = [];
});

describe("pty gc — keep-tag expiry", () => {
  it("keeps an exited keep session that is younger than the default window", () => {
    const dir = makeSessionDir();
    const name = uniqueName();
    const metaPath = writeExitedKeep(dir, name, 2 * DAY_MS);

    const r = runCli(dir, "gc");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Kept (keep tag): ${name}`);
    expect(r.stdout).not.toContain("keep expired");
    expect(fs.existsSync(metaPath)).toBe(true);
  }, 10000);

  it("sweeps an exited keep session older than the default window, reported apart from the plain sweep", () => {
    const dir = makeSessionDir();
    const expired = uniqueName();
    const stale = uniqueName();
    const expiredPath = writeExitedKeep(dir, expired, 30 * DAY_MS);
    // A same-age session WITHOUT the tag: proves the two buckets stay
    // distinct rather than one absorbing the other.
    const stalePath = writeExitedKeep(dir, stale, 30 * DAY_MS, {});

    const r = runCli(dir, "gc");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Removed (keep expired after 7d): ${expired}`);
    expect(r.stdout).toContain(`Removed: ${stale}`);
    expect(r.stdout).toContain("1 stale session");
    expect(r.stdout).toContain("1 keep-expired session");
    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(fs.existsSync(stalePath)).toBe(false);
  }, 10000);

  it("honours a custom --keep-max-age window in both flag spellings", () => {
    const dir = makeSessionDir();
    const spaced = uniqueName();
    const equals = uniqueName();
    const spacedPath = writeExitedKeep(dir, spaced, 2 * 60 * 60 * 1000);
    const equalsPath = writeExitedKeep(dir, equals, 2 * 60 * 60 * 1000);

    // 3h window: both sessions are 2h dead, so both survive.
    const kept = runCli(dir, "gc", "--keep-max-age", "3h");
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toContain(`Kept (keep tag): ${spaced}`);
    expect(kept.stdout).toContain(`Kept (keep tag): ${equals}`);
    expect(fs.existsSync(spacedPath)).toBe(true);

    // 1h window: both are past it.
    const swept = runCli(dir, "gc", "--keep-max-age=1h");
    expect(swept.status, swept.stderr).toBe(0);
    expect(swept.stdout).toContain(`Removed (keep expired after 1h): ${spaced}`);
    expect(swept.stdout).toContain(`Removed (keep expired after 1h): ${equals}`);
    expect(fs.existsSync(spacedPath)).toBe(false);
    expect(fs.existsSync(equalsPath)).toBe(false);
  }, 10000);

  it("--keep-max-age 0 sweeps a keep session that just exited", () => {
    const dir = makeSessionDir();
    const name = uniqueName();
    const metaPath = writeExitedKeep(dir, name, 0);

    const r = runCli(dir, "gc", "--keep-max-age", "0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Removed (keep expired after 0s): ${name}`);
    expect(fs.existsSync(metaPath)).toBe(false);
  }, 10000);

  it("sweeps an expired keep session with no exit record, anchored on createdAt", () => {
    const dir = makeSessionDir();
    const name = uniqueName();
    // A vanished session (SIGKILLed daemon) never wrote `exitedAt`, so its
    // age comes from `createdAt` — the same anchor precedence `pty list
    // --older-than` uses.
    const metaPath = path.join(dir, `${name}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      command: "cat",
      args: [],
      displayCommand: "cat",
      cwd: os.tmpdir(),
      createdAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      tags: { keep: "true" },
    }));

    const r = runCli(dir, "gc");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Removed (keep expired after 7d): ${name}`);
    expect(fs.existsSync(metaPath)).toBe(false);
  }, 10000);

  it("never sweeps a RUNNING keep session, even at --keep-max-age 0", () => {
    const dir = makeSessionDir();
    const name = uniqueName();
    const metaPath = path.join(dir, `${name}.json`);
    // The test runner's own pid stands in for a live daemon (same device as
    // tests/list-filters.test.ts): an alive pid with no exit record reads as
    // status=running. Aged well past the window so the only thing keeping it
    // out of the sweep is that it is still running.
    fs.writeFileSync(path.join(dir, `${name}.pid`), String(process.pid));
    fs.writeFileSync(metaPath, JSON.stringify({
      command: "cat",
      args: [],
      displayCommand: "cat",
      cwd: os.tmpdir(),
      createdAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      tags: { keep: "true" },
    }));
    expect(listSessionStatus(dir, name)).toBe("running");

    const r = runCli(dir, "gc", "--keep-max-age", "0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(name);
    expect(fs.existsSync(metaPath)).toBe(true);
    expect(listSessionStatus(dir, name)).toBe("running");
  }, 10000);

  it("--dry-run previews keep expiry without removing anything", () => {
    const dir = makeSessionDir();
    const name = uniqueName();
    const metaPath = writeExitedKeep(dir, name, 30 * DAY_MS);

    const dry = runCli(dir, "gc", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`Would remove (keep expired after 7d): ${name}`);
    expect(dry.stdout).toContain("1 keep-expired session");
    expect(dry.stdout).toContain("Dry run");
    expect(fs.existsSync(metaPath)).toBe(true);

    // Zero-window dry run is equally non-mutating.
    const dryZero = runCli(dir, "gc", "-n", "--keep-max-age", "0");
    expect(dryZero.status, dryZero.stderr).toBe(0);
    expect(dryZero.stdout).toContain(`Would remove (keep expired after 0s): ${name}`);
    expect(fs.existsSync(metaPath)).toBe(true);

    // And the real pass then actually removes it.
    const real = runCli(dir, "gc");
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toContain(`Removed (keep expired after 7d): ${name}`);
    expect(fs.existsSync(metaPath)).toBe(false);
  }, 15000);

  it("rejects a unit-less non-zero --keep-max-age", () => {
    const dir = makeSessionDir();
    const bare = runCli(dir, "gc", "--keep-max-age", "7");
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("--keep-max-age expects a duration like 12h, 7d, or 0");

    const junk = runCli(dir, "gc", "--keep-max-age=soon");
    expect(junk.status).not.toBe(0);
    expect(junk.stderr).toContain("--keep-max-age expects a duration like 12h, 7d, or 0");
  }, 10000);
});
