import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkCommand = path.join(repoRoot, "bin", "pty-kill-releases-socket-test");
const ptyCommand = path.join(repoRoot, "bin", "pty");

describe("pty-kill-releases-socket-test", () => {
  it("completes a real kill-then-restart cycle with the same owned socket", () => {
    const output = execFileSync(checkCommand, {
      cwd: repoRoot,
      env: { ...process.env, PTY_TEST_BIN: ptyCommand },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(output).toContain(`PASS ${process.platform}`);
  }, 20_000);
});
