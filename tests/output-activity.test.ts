// Tests for the daemon-stamped `lastOutputAt` session metadata field: the
// daemon stamps every PTY output chunk in-memory and persists it debounced
// (≤1 write/second) so downstream consumers (st2 observed harness state) can
// derive session activity without observing the output stream themselves.
//
// These are integration tests against a real daemon process: the debounce
// timer lives in the daemon, not in this process, so fake timers cannot drive
// it — the real platform clock is the system under test.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { terminateAndWait } from "./setup/processes.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const serverModule = path.join(__dirname, "..", "dist", "server.js");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pty-activity-"));

const bgPids: number[] = [];
const sessionDirs: string[] = [];
const runningDaemons: { sessionDir: string; name: string }[] = [];

function makeSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(testRoot, "d-"));
  sessionDirs.push(dir);
  return dir;
}

let nameCounter = 0;
function uniqueName(): string {
  return `act${++nameCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms: number): Promise<void> {
  // Executor form: the repo's tsconfig lib predates Promise.withResolvers.
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function startDaemon(sessionDir: string, name: string): Promise<void> {
  const config = JSON.stringify({
    name, command: "cat", args: [], displayCommand: "cat",
    cwd: os.tmpdir(), rows: 24, cols: 80,
  });
  const child = spawn(nodeBin, [serverModule], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PTY_SERVER_CONFIG: config, PTY_SESSION_DIR: sessionDir },
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
  let exitCode: number | null = null;
  child.on("exit", (code) => { exitCode = code; });
  child.unref();

  const socketPath = path.join(sessionDir, `${name}.sock`);
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (exitCode !== null) throw new Error(`Daemon exited: ${stderr}`);
    if (fs.existsSync(socketPath)) {
      await sleep(100);
      bgPids.push(child.pid!);
      return;
    }
    await sleep(50);
  }
  throw new Error("Timeout waiting for daemon");
}

function runCli(sessionDir: string, ...args: string[]) {
  return spawnSync(nodeBin, [cliPath, ...args], {
    env: { ...process.env, PTY_SESSION_DIR: sessionDir },
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function readLastOutputAt(sessionDir: string, name: string): string | undefined {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir, `${name}.json`), "utf8"));
  if (typeof raw !== "object" || raw === null || !("lastOutputAt" in raw)) return undefined;
  const value = (raw as { lastOutputAt: unknown }).lastOutputAt;
  return typeof value === "string" ? value : undefined;
}

async function waitFor(
  poll: () => boolean,
  timeoutMs = 5000,
  stepMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (poll()) return;
    await sleep(stepMs);
  }
  throw new Error("Condition not met within timeout");
}

afterEach(async () => {
  const pids: number[] = [];
  while (runningDaemons.length > 0) {
    const { sessionDir, name } = runningDaemons.pop()!;
    try {
      pids.push(parseInt(fs.readFileSync(path.join(sessionDir, `${name}.pid`), "utf8"), 10));
    } catch {}
  }
  // Await before the afterAll rmtree: a daemon that is still writing would
  // race the directory removal with ENOTEMPTY.
  if (pids.length > 0) await terminateAndWait(pids);
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("lastOutputAt session activity stamp", () => {
  it("is absent before the session produces any output", async () => {
    const sessionDir = makeSessionDir();
    const name = uniqueName();
    await startDaemon(sessionDir, name);
    runningDaemons.push({ sessionDir, name });

    expect(readLastOutputAt(sessionDir, name)).toBeUndefined();
  });

  it("appears after output and carries a recent ISO timestamp", async () => {
    const sessionDir = makeSessionDir();
    const name = uniqueName();
    await startDaemon(sessionDir, name);
    runningDaemons.push({ sessionDir, name });

    const before = Date.now();
    // cat echoes stdin back — one line in, one chunk of PTY output out.
    const sent = runCli(sessionDir, "send", name, "--seq", "activity-probe", "--seq", "key:return");
    expect(sent.status).toBe(0);

    await waitFor(() => readLastOutputAt(sessionDir, name) !== undefined);

    const stampedAt = new Date(readLastOutputAt(sessionDir, name)!).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(stampedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("updates the stamp on subsequent output bursts", async () => {
    const sessionDir = makeSessionDir();
    const name = uniqueName();
    await startDaemon(sessionDir, name);
    runningDaemons.push({ sessionDir, name });

    runCli(sessionDir, "send", name, "--seq", "first", "--seq", "key:return");
    await waitFor(() => readLastOutputAt(sessionDir, name) !== undefined);
    const first = new Date(readLastOutputAt(sessionDir, name)!).getTime();

    // Wait out the 1s debounce window so the second burst cannot coalesce
    // into the first persist, then require the stamp to move forward.
    await sleep(1600);
    runCli(sessionDir, "send", name, "--seq", "second", "--seq", "key:return");
    await waitFor(() => {
      const stamp = readLastOutputAt(sessionDir, name);
      return stamp !== undefined && new Date(stamp).getTime() > first;
    }, 5000);
  });
});
