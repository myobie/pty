import { describe, it, expect, afterEach, afterAll } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Terminal } from "@xterm/headless";
import { PtyServer, type ServerOptions } from "../src/server.ts";
import {
  MessageType,
  PacketReader,
  Packet,
  encodeAttach,
  encodeData,
  encodeDetach,
  encodePeek,
  encodeResize,
  decodeExit,
} from "../src/protocol.ts";
import {
  getSocketPath,
  getMetadataPath,
  cleanupAll,
  readMetadata,
  validateName,
  acquireLock,
  releaseLock,
} from "../src/sessions.ts";

// All tests run in a tmp directory to avoid polluting the project
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pty-int-"));
afterAll(() => {
  fs.rmSync(testCwd, { recursive: true, force: true });
});

let servers: PtyServer[] = [];
let sessionNames: string[] = [];

function uniqueName(): string {
  const name = `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  sessionNames.push(name);
  return name;
}

async function startServer(
  name: string,
  command: string,
  args: string[] = [],
  opts: Partial<ServerOptions> = {}
): Promise<PtyServer> {
  const server = new PtyServer({
    name,
    command,
    args,
    displayCommand: command,
    cwd: testCwd,
    rows: 24,
    cols: 80,
    ...opts,
  });
  servers.push(server);
  await server.ready;
  return server;
}

function connect(name: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getSocketPath(name));
    socket.on("connect", () => resolve(socket));
    socket.on("error", reject);
  });
}

/** Collect packets from a socket until we have at least `count`, or timeout. */
function collectPackets(
  socket: net.Socket,
  reader: PacketReader,
  count: number,
  timeoutMs = 5000
): Promise<Packet[]> {
  return new Promise((resolve) => {
    const packets: Packet[] = [];
    const timer = setTimeout(() => resolve(packets), timeoutMs);

    function onData(data: Buffer) {
      packets.push(...reader.feed(data));
      if (packets.length >= count) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(packets);
      }
    }

    socket.on("data", onData);
  });
}

/** Wait for a specific message type. */
function waitForType(
  socket: net.Socket,
  reader: PacketReader,
  type: MessageType,
  timeoutMs = 5000
): Promise<Packet> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for message type ${type}`)),
      timeoutMs
    );

    function onData(data: Buffer) {
      const packets = reader.feed(data);
      for (const packet of packets) {
        if (packet.type === type) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve(packet);
          return;
        }
      }
    }

    socket.on("data", onData);
  });
}

afterEach(async () => {
  for (const server of servers) {
    await server.close();
  }
  servers = [];
  for (const name of sessionNames) {
    cleanupAll(name);
  }
  sessionNames = [];
});

describe("integration", () => {
  it("starts a session and receives screen on attach", async () => {
    const name = uniqueName();
    await startServer(name, "echo", ["hello"]);

    const socket = connect(name);
    const client = await socket;
    const reader = new PacketReader();

    // Send ATTACH
    client.write(encodeAttach(24, 80));

    // Should get a SCREEN packet back
    const screenPacket = await waitForType(client, reader, MessageType.SCREEN);
    expect(screenPacket.type).toBe(MessageType.SCREEN);

    client.destroy();
  });

  it("receives process output via screen replay", async () => {
    const name = uniqueName();
    // Use a command that prints and stays alive so the terminal has time to process
    await startServer(name, "sh", ["-c", "echo 'hello world'; sleep 30"]);

    // Small delay to let xterm-headless process the output
    await new Promise((r) => setTimeout(r, 200));

    const client = await connect(name);
    const reader = new PacketReader();

    client.write(encodeAttach(24, 80));

    // The SCREEN packet should contain the buffered output
    const screenPacket = await waitForType(client, reader, MessageType.SCREEN);
    expect(screenPacket.payload.toString()).toContain("hello world");

    client.destroy();
  });

  it("sends input to the PTY process", async () => {
    const name = uniqueName();
    // `cat` echoes stdin back to stdout
    await startServer(name, "cat");

    const client = await connect(name);
    const reader = new PacketReader();

    client.write(encodeAttach(24, 80));

    // Wait for initial SCREEN packet
    await waitForType(client, reader, MessageType.SCREEN);

    // Send some input
    client.write(encodeData("test input\n"));

    // Should get it echoed back as DATA
    const dataPacket = await waitForType(client, reader, MessageType.DATA, 3000);
    expect(dataPacket.payload.toString()).toContain("test input");

    client.destroy();
  });

  it("detach and reattach with screen replay", async () => {
    const name = uniqueName();
    // Use sh to print something then wait
    await startServer(name, "sh", ["-c", "echo 'persistent output'; sleep 30"]);

    // Let xterm-headless process the output
    await new Promise((r) => setTimeout(r, 200));

    // First client: attach, get output, detach
    const client1 = await connect(name);
    const reader1 = new PacketReader();

    client1.write(encodeAttach(24, 80));

    // Collect output until we see our text
    const packets1 = await collectPackets(client1, reader1, 2, 3000);
    const output1 = packets1
      .filter((p) => p.type === MessageType.DATA || p.type === MessageType.SCREEN)
      .map((p) => p.payload.toString())
      .join("");
    expect(output1).toContain("persistent output");

    // Detach
    client1.write(encodeDetach());
    await new Promise((r) => client1.on("close", r));

    // Second client: reattach, should get screen replay with the output
    const client2 = await connect(name);
    const reader2 = new PacketReader();

    client2.write(encodeAttach(24, 80));

    const screenPacket = await waitForType(client2, reader2, MessageType.SCREEN);
    expect(screenPacket.payload.toString()).toContain("persistent output");

    client2.destroy();
  });

  it("receives EXIT when process terminates", async () => {
    const name = uniqueName();
    // Process that exits with code 42
    await startServer(name, "sh", ["-c", "exit 42"]);

    const client = await connect(name);
    const reader = new PacketReader();

    client.write(encodeAttach(24, 80));

    const exitPacket = await waitForType(client, reader, MessageType.EXIT, 3000);
    expect(exitPacket.type).toBe(MessageType.EXIT);
    expect(decodeExit(exitPacket.payload)).toBe(42);

    client.destroy();
  });

  it("handles resize", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const client = await connect(name);
    const reader = new PacketReader();

    client.write(encodeAttach(24, 80));
    await waitForType(client, reader, MessageType.SCREEN);

    // Resize — shouldn't crash or error
    client.write(encodeResize(48, 120));

    // Send some data after resize to verify things still work
    client.write(encodeData("after resize\n"));

    const dataPacket = await waitForType(client, reader, MessageType.DATA, 3000);
    expect(dataPacket.payload.toString()).toContain("after resize");

    client.destroy();
  });

  it("supports multiple simultaneous clients", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const client1 = await connect(name);
    const reader1 = new PacketReader();
    const client2 = await connect(name);
    const reader2 = new PacketReader();

    client1.write(encodeAttach(24, 80));
    client2.write(encodeAttach(24, 80));

    await waitForType(client1, reader1, MessageType.SCREEN);
    await waitForType(client2, reader2, MessageType.SCREEN);

    // Client 1 sends input — both should receive the echo
    client1.write(encodeData("shared input\n"));

    const data1 = await waitForType(client1, reader1, MessageType.DATA, 3000);
    const data2 = await waitForType(client2, reader2, MessageType.DATA, 3000);

    expect(data1.payload.toString()).toContain("shared input");
    expect(data2.payload.toString()).toContain("shared input");

    client1.destroy();
    client2.destroy();
  });

  it("cleans up socket and pid files on close", async () => {
    const name = uniqueName();
    const server = await startServer(name, "cat");

    const socketPath = getSocketPath(name);

    // Socket should exist
    const fs = await import("node:fs");
    expect(fs.existsSync(socketPath)).toBe(true);

    await server.close();

    // Socket should be gone
    expect(fs.existsSync(socketPath)).toBe(false);

    // Remove from tracking so afterEach doesn't double-close
    servers = servers.filter((s) => s !== server);
  });

  it("peek receives screen replay without affecting the session", async () => {
    const name = uniqueName();
    await startServer(name, "sh", ["-c", "echo 'peek test output'; sleep 30"]);
    await new Promise((r) => setTimeout(r, 200));

    // Peek client
    const peeker = await connect(name);
    const peekReader = new PacketReader();

    peeker.write(encodePeek());

    const screenPacket = await waitForType(peeker, peekReader, MessageType.SCREEN);
    expect(screenPacket.payload.toString()).toContain("peek test output");

    peeker.destroy();
  });

  it("peek client input is ignored by server", async () => {
    const name = uniqueName();
    // Use cat — if input reaches it, it would echo back
    await startServer(name, "cat");

    // Regular client to observe
    const watcher = await connect(name);
    const watchReader = new PacketReader();
    watcher.write(encodeAttach(24, 80));
    await waitForType(watcher, watchReader, MessageType.SCREEN);

    // Peek client sends DATA — server should ignore it
    const peeker = await connect(name);
    const peekReader = new PacketReader();
    peeker.write(encodePeek());
    await waitForType(peeker, peekReader, MessageType.SCREEN);

    peeker.write(encodeData("this should be ignored\n"));

    // Wait a bit — if the input were forwarded, cat would echo it back
    const packets = await collectPackets(watcher, watchReader, 1, 500);
    const echoed = packets
      .filter((p) => p.type === MessageType.DATA)
      .map((p) => p.payload.toString())
      .join("");
    expect(echoed).not.toContain("this should be ignored");

    watcher.destroy();
    peeker.destroy();
  });

  it("peek client does not affect terminal size", async () => {
    const name = uniqueName();
    await startServer(name, "cat", [], { rows: 24, cols: 80 });

    // Attach a regular client with specific size
    const client = await connect(name);
    const clientReader = new PacketReader();
    client.write(encodeAttach(30, 100));
    await waitForType(client, clientReader, MessageType.SCREEN);

    // Peek client sends RESIZE — server should ignore it
    const peeker = await connect(name);
    const peekReader = new PacketReader();
    peeker.write(encodePeek());
    await waitForType(peeker, peekReader, MessageType.SCREEN);
    peeker.write(encodeResize(10, 10));

    // Send input through the regular client — if resize happened, output would differ
    // Just verify no crash and the session is still functional
    client.write(encodeData("still works\n"));
    const data = await waitForType(client, clientReader, MessageType.DATA, 3000);
    expect(data.payload.toString()).toContain("still works");

    client.destroy();
    peeker.destroy();
  });

  it("peek receives live DATA when following", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const peeker = await connect(name);
    const peekReader = new PacketReader();
    peeker.write(encodePeek());
    await waitForType(peeker, peekReader, MessageType.SCREEN);

    // Regular client sends input
    const client = await connect(name);
    const clientReader = new PacketReader();
    client.write(encodeAttach(24, 80));
    await waitForType(client, clientReader, MessageType.SCREEN);

    client.write(encodeData("live data\n"));

    // Peeker should receive the echoed output as DATA
    const dataPacket = await waitForType(peeker, peekReader, MessageType.DATA, 3000);
    expect(dataPacket.payload.toString()).toContain("live data");

    client.destroy();
    peeker.destroy();
  });

  it("peek captures TUI app running in alternate screen buffer", async () => {
    const name = uniqueName();
    // Simulate a TUI app: enter alt screen, enable mouse tracking, draw content
    await startServer(name, "sh", [
      "-c",
      "printf '\\033[?1049h';" + // enter alternate screen
        "printf '\\033[?1000h';" + // enable mouse click tracking
        "printf '\\033[?1003h';" + // enable mouse any-event tracking
        "printf '\\033[?1h';" + // enable application cursor keys
        "printf '\\033[H';" + // home cursor
        "printf '\\033[32mTUI-PEEK-TEST\\033[0m\\n';" +
        "printf 'Status: running\\n';" +
        "sleep 30",
    ]);

    await new Promise((r) => setTimeout(r, 300));

    // Peek should capture the alternate screen content
    const peeker = await connect(name);
    const peekReader = new PacketReader();
    peeker.write(encodePeek());

    const screenPacket = await waitForType(peeker, peekReader, MessageType.SCREEN);
    const screen = screenPacket.payload.toString();
    expect(screen).toContain("TUI-PEEK-TEST");
    expect(screen).toContain("Status: running");

    peeker.destroy();
  });

  it("writes session metadata on creation", async () => {
    const name = uniqueName();
    await startServer(name, "cat", ["-u"]);

    const meta = readMetadata(name);
    expect(meta).not.toBeNull();
    expect(meta!.command).toBe("cat");
    expect(meta!.args).toEqual(["-u"]);
    expect(meta!.createdAt).toBeTruthy();
    expect(meta!.exitCode).toBeUndefined();
  });

  it("screen replay includes scrollback content", async () => {
    const name = uniqueName();
    // Generate enough output to scroll past the visible 24 rows
    const lines = Array.from({ length: 40 }, (_, i) => `scrollback-line-${i}`);
    const script = lines.map((l) => `echo '${l}'`).join("; ");
    await startServer(name, "sh", ["-c", `${script}; sleep 30`]);

    await new Promise((r) => setTimeout(r, 300));

    const client = await connect(name);
    const reader = new PacketReader();
    client.write(encodeAttach(24, 80));

    const screenPacket = await waitForType(client, reader, MessageType.SCREEN);
    const screen = screenPacket.payload.toString();

    // The screen replay should include content that scrolled off — at minimum the last visible lines
    expect(screen).toContain("scrollback-line-39");
    // And earlier lines that are now in scrollback
    expect(screen).toContain("scrollback-line-0");

    client.destroy();
  });

  it("saves last lines and exit code on process exit", async () => {
    const name = uniqueName();
    const server = await startServer(name, "sh", [
      "-c",
      "echo 'line one'; echo 'line two'; echo 'line three'; sleep 0.2; exit 7",
    ]);

    // Wait for the process to exit and metadata to be written
    await new Promise((r) => setTimeout(r, 500));

    const meta = readMetadata(name);
    expect(meta).not.toBeNull();
    expect(meta!.exitCode).toBe(7);
    expect(meta!.exitedAt).toBeTruthy();
    expect(meta!.lastLines).toBeDefined();
    expect(meta!.lastLines!.some((l) => l.includes("line one"))).toBe(true);
    expect(meta!.lastLines!.some((l) => l.includes("line three"))).toBe(true);
  });

  it("metadata persists after server closes", async () => {
    const name = uniqueName();
    const server = await startServer(name, "sh", ["-c", "echo 'persist me'; sleep 0.2; exit 0"]);

    await new Promise((r) => setTimeout(r, 500));
    await server.close();
    servers = servers.filter((s) => s !== server);

    // Socket should be gone but metadata should remain
    const fs = await import("node:fs");
    expect(fs.existsSync(getSocketPath(name))).toBe(false);
    expect(fs.existsSync(getMetadataPath(name))).toBe(true);

    const meta = readMetadata(name);
    expect(meta!.lastLines!.some((l) => l.includes("persist me"))).toBe(true);

    // Clean up metadata
    cleanupAll(name);
  });

  it("validates session names", () => {
    expect(() => validateName("good-name")).not.toThrow();
    expect(() => validateName("my.session_1")).not.toThrow();
    expect(() => validateName("")).toThrow(/empty/);
    expect(() => validateName("bad/name")).toThrow(/Invalid session name/);
    expect(() => validateName("../traversal")).toThrow(/Invalid session name/);
    expect(() => validateName("has spaces")).toThrow(/Invalid session name/);
    expect(() => validateName("a".repeat(256))).toThrow(/too long/);
  });

  it("lock prevents double acquire, release allows reacquire", () => {
    const name = uniqueName();
    expect(acquireLock(name)).toBe(true);
    // Same process — should fail since we already hold it
    // (lock file exists with our PID, and we're alive)
    expect(acquireLock(name)).toBe(false);
    releaseLock(name);
    // After release, should succeed
    expect(acquireLock(name)).toBe(true);
    releaseLock(name);
  });

  it("lock with garbage content is treated as stale", async () => {
    const name = uniqueName();
    const fs = await import("node:fs");
    const { ensureSessionDir } = await import("../src/sessions.ts");
    ensureSessionDir();

    // Write garbage to the lock file
    const lockPath = getSocketPath(name).replace(".sock", ".lock");
    fs.writeFileSync(lockPath, "not-a-pid");

    // Should steal the lock
    expect(acquireLock(name)).toBe(true);
    releaseLock(name);
  });

  it("last attached client wins for terminal size", async () => {
    const name = uniqueName();
    // Use tput to print terminal dimensions — it reads from the PTY
    await startServer(name, "cat", [], { rows: 24, cols: 80 });

    // Client 1 attaches with 30x100
    const client1 = await connect(name);
    const reader1 = new PacketReader();
    client1.write(encodeAttach(30, 100));
    await waitForType(client1, reader1, MessageType.SCREEN);

    // Client 2 attaches with 40x120
    const client2 = await connect(name);
    const reader2 = new PacketReader();
    client2.write(encodeAttach(40, 120));
    await waitForType(client2, reader2, MessageType.SCREEN);

    // Now client 1 re-attaches with 50x150 — should win because it's most recent
    client1.write(encodeAttach(50, 150));
    await waitForType(client1, reader1, MessageType.SCREEN);

    // Verify the session still works and the size was applied
    // (We can't easily read back the PTY size, but we can confirm no crash
    // and that input/output still works after the re-attach)
    client1.write(encodeData("size-test\n"));
    const data = await waitForType(client1, reader1, MessageType.DATA, 3000);
    expect(data.payload.toString()).toContain("size-test");

    client1.destroy();
    client2.destroy();
  });

  it("server handles truncated ATTACH payload gracefully", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const client = await connect(name);
    const reader = new PacketReader();

    // Send a malformed ATTACH with only 2 bytes payload instead of 4
    const { encodePacket, MessageType: MT } = await import(
      "../src/protocol.ts"
    );
    const badAttach = encodePacket(MT.ATTACH, Buffer.alloc(2));
    client.write(badAttach);

    // Send a proper ATTACH after — server should still work
    client.write(encodeAttach(24, 80));
    const screen = await waitForType(client, reader, MessageType.SCREEN);
    expect(screen.type).toBe(MessageType.SCREEN);

    client.destroy();
  });

  it("server handles truncated RESIZE payload gracefully", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const client = await connect(name);
    const reader = new PacketReader();
    client.write(encodeAttach(24, 80));
    await waitForType(client, reader, MessageType.SCREEN);

    // Send malformed RESIZE with 1 byte payload
    const { encodePacket, MessageType: MT } = await import(
      "../src/protocol.ts"
    );
    client.write(encodePacket(MT.RESIZE, Buffer.alloc(1)));

    // Session should still work
    client.write(encodeData("after-bad-resize\n"));
    const data = await waitForType(client, reader, MessageType.DATA, 3000);
    expect(data.payload.toString()).toContain("after-bad-resize");

    client.destroy();
  });

  it("server ignores unknown message types", async () => {
    const name = uniqueName();
    await startServer(name, "cat");

    const client = await connect(name);
    const reader = new PacketReader();
    client.write(encodeAttach(24, 80));
    await waitForType(client, reader, MessageType.SCREEN);

    // Send a packet with unknown type 99
    const header = Buffer.alloc(5);
    header.writeUInt8(99, 0);
    header.writeUInt32BE(3, 1);
    client.write(Buffer.concat([header, Buffer.from("abc")]));

    // Session should still work
    client.write(encodeData("after-unknown\n"));
    const data = await waitForType(client, reader, MessageType.DATA, 3000);
    expect(data.payload.toString()).toContain("after-unknown");

    client.destroy();
  });

  it("SCREEN cursor position matches process intent after resize", async () => {
    const name = uniqueName();

    // TUI-like process: enters alt screen, positions cursor at col 60.
    // On SIGWINCH: redraws with cursor at col 10.
    // Using "sleep & wait" so bash processes the trap immediately when
    // SIGWINCH interrupts the wait builtin (no sleep cycle delay).
    await startServer(
      name,
      "bash",
      [
        "-c",
        "printf '\\033[?1049h\\033[2J\\033[1;1HTitle\\033[5;60H'; " +
          "trap 'printf \"\\033[2J\\033[1;1HTitle\\033[5;10H\"' WINCH; " +
          "sleep 300 & wait; sleep 300",
      ],
      { rows: 24, cols: 80 }
    );

    await new Promise((r) => setTimeout(r, 500));

    // Attach at original size, verify cursor is at (row 5, col 60) = (4, 59) 0-indexed
    const client1 = await connect(name);
    const reader1 = new PacketReader();
    client1.write(encodeAttach(24, 80));
    const screen1 = await waitForType(client1, reader1, MessageType.SCREEN);

    const t1 = new Terminal({ rows: 24, cols: 80, allowProposedApi: true });
    await new Promise<void>((r) => t1.write(screen1.payload.toString(), r));
    expect(t1.buffer.active.cursorY).toBe(4);
    expect(t1.buffer.active.cursorX).toBe(59);
    t1.dispose();

    client1.destroy();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect at a NARROWER terminal — col 60 doesn't exist in 40 cols.
    // The server resizes xterm-headless to 40 cols (clamping cursor to col 39),
    // then serializes BEFORE the process can respond to SIGWINCH.
    const client2 = await connect(name);
    const reader2 = new PacketReader();
    client2.write(encodeAttach(24, 40));
    const screen2 = await waitForType(client2, reader2, MessageType.SCREEN);

    const t2 = new Terminal({ rows: 24, cols: 40, allowProposedApi: true });
    await new Promise<void>((r) => t2.write(screen2.payload.toString(), r));

    // The process's SIGWINCH trap will redraw with cursor at (4, 9).
    // But SCREEN was serialized before the trap could fire, so the cursor
    // is at the clamped position (4, 39) — not where the process wants it.
    expect(t2.buffer.active.cursorY).toBe(4);
    expect(t2.buffer.active.cursorX).toBe(9); // FAILS: actual is 39 (clamped)
    t2.dispose();

    client2.destroy();
  }, 15000);
});
