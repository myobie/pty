import * as net from "node:net";
import * as tty from "node:tty";
import {
  MessageType,
  PacketReader,
  encodeAttach,
  encodeData,
  encodeDetach,
  encodePeek,
  encodeResize,
  decodeExit,
} from "./protocol.ts";
import { getSocketPath } from "./sessions.ts";

const DETACH_KEY = 0x1c; // Ctrl+\ (legacy encoding)
const DETACH_KEY_KITTY = "\x1b[92;5u"; // Ctrl+\ (Kitty keyboard protocol)

/** Replace Kitty keyboard protocol encoding of Ctrl+\ with the legacy byte
 *  so the rest of the detach logic can work with a single representation. */
function normalizeDetachKey(data: Buffer): Buffer {
  const str = data.toString();
  if (!str.includes(DETACH_KEY_KITTY)) return data;
  return Buffer.from(
    str.replaceAll(DETACH_KEY_KITTY, String.fromCharCode(DETACH_KEY))
  );
}

// Reset terminal modes that programs may have enabled. This prevents
// "poisoned" terminals after detach/peek (e.g., mouse tracking, hidden
// cursor, bracketed paste). Does NOT clear screen content.
const TERMINAL_SANITIZE =
  "\x1b[?1000l" + // disable mouse click tracking
  "\x1b[?1002l" + // disable mouse button-event tracking
  "\x1b[?1003l" + // disable mouse any-event tracking
  "\x1b[?1006l" + // disable SGR mouse mode
  "\x1b[?25h" + // show cursor
  "\x1b[?2004l" + // disable bracketed paste
  "\x1b[<u"; // pop Kitty keyboard protocol mode

export interface PeekOptions {
  name: string;
  follow?: boolean; // If true, stay connected and stream (like tail -f). If false, print screen and exit.
  onExit?: (code: number) => void;
  onDetach?: () => void;
}

/** Read-only view of a session. Input is ignored by the server. */
export function peek(options: PeekOptions): void {
  const socketPath = getSocketPath(options.name);
  const reader = new PacketReader();
  const socket = net.createConnection(socketPath);
  const stdout = process.stdout;
  const follow = options.follow ?? false;

  socket.on("connect", () => {
    socket.write(encodePeek());

    if (follow) {
      // In follow mode, Ctrl+\ detaches
      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode(true);

      stdin.on("data", (raw: Buffer) => {
        const data = normalizeDetachKey(raw);
        for (let i = 0; i < data.length; i++) {
          if (data[i] === DETACH_KEY) {
            if (stdin.isTTY) stdin.setRawMode(false);
            socket.destroy();
            stdout.write(TERMINAL_SANITIZE + "\r\n[detached]\r\n");
            options.onDetach?.();
            return;
          }
        }
        // All other input is silently ignored (read-only)
      });
    }
  });

  socket.on("data", (data: Buffer) => {
    const packets = reader.feed(data);
    for (const packet of packets) {
      switch (packet.type) {
        case MessageType.SCREEN:
          stdout.write(packet.payload);
          if (!follow) {
            stdout.write(TERMINAL_SANITIZE + "\n");
            socket.destroy();
            return;
          }
          break;

        case MessageType.DATA:
          if (follow) {
            stdout.write(packet.payload);
          }
          break;

        case MessageType.EXIT: {
          const code = decodeExit(packet.payload);
          socket.destroy();
          stdout.write(TERMINAL_SANITIZE);
          if (follow) {
            stdout.write(`\r\n[session exited with code ${code}]\r\n`);
          }
          options.onExit?.(code);
          return;
        }
      }
    }
  });

  socket.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      console.error(`Session "${options.name}" not found or not running.`);
    } else {
      console.error(`Connection error: ${err.message}`);
    }
    process.exit(1);
  });

  socket.on("close", () => {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  });
}

export interface AttachOptions {
  name: string;
  onExit?: (code: number) => void;
  onDetach?: () => void;
}

export function attach(options: AttachOptions): void {
  const socketPath = getSocketPath(options.name);
  const reader = new PacketReader();
  const socket = net.createConnection(socketPath);

  const stdin = process.stdin;
  const stdout = process.stdout;

  let detaching = false;
  let rawWasSet = false;
  let exitCode = 0;

  function enterRawMode(): void {
    if (stdin.isTTY && !stdin.isRaw) {
      stdin.setRawMode(true);
      rawWasSet = true;
    }
  }

  function exitRawMode(): void {
    if (rawWasSet && stdin.isTTY) {
      stdin.setRawMode(false);
    }
  }

  function cleanExit(): void {
    exitRawMode();
    socket.destroy();
  }

  socket.on("connect", () => {
    enterRawMode();

    // Tell the server our terminal size
    const rows = (stdout as tty.WriteStream).rows ?? 24;
    const cols = (stdout as tty.WriteStream).columns ?? 80;
    socket.write(encodeAttach(rows, cols));

    // Forward stdin to server
    // Double Ctrl+\ passthrough: press once = detach, press twice quickly = send Ctrl+\ to process
    let lastDetachKeyTime = 0;
    const DOUBLE_TAP_MS = 300;

    stdin.on("data", (raw: Buffer) => {
      const data = normalizeDetachKey(raw);

      // Fast path: no detach key in this chunk
      if (data.indexOf(DETACH_KEY) === -1) {
        socket.write(encodeData(data.toString()));
        return;
      }

      // Slow path: detach key found — process byte by byte
      const forward: number[] = [];

      for (let i = 0; i < data.length; i++) {
        if (data[i] === DETACH_KEY) {
          const now = Date.now();
          if (now - lastDetachKeyTime < DOUBLE_TAP_MS) {
            // Double-tap: send Ctrl+\ to the process, reset timer
            lastDetachKeyTime = 0;
            forward.push(DETACH_KEY);
          } else {
            // First tap: schedule detach (will fire if no second tap)
            lastDetachKeyTime = now;
            setTimeout(() => {
              if (lastDetachKeyTime === now) {
                detaching = true;
                socket.write(encodeDetach());
                cleanExit();
                stdout.write(TERMINAL_SANITIZE + "\r\n[detached]\r\n");
                options.onDetach?.();
              }
            }, DOUBLE_TAP_MS);
          }
        } else {
          forward.push(data[i]);
        }
      }

      if (forward.length > 0) {
        socket.write(encodeData(Buffer.from(forward).toString()));
      }
    });

    // Handle terminal resize
    if (stdout instanceof tty.WriteStream) {
      stdout.on("resize", () => {
        const rows = stdout.rows;
        const cols = stdout.columns;
        socket.write(encodeResize(rows, cols));
      });
    }
  });

  socket.on("data", (data: Buffer) => {
    const packets = reader.feed(data);
    for (const packet of packets) {
      switch (packet.type) {
        case MessageType.DATA:
          stdout.write(packet.payload);
          break;

        case MessageType.SCREEN:
          // Clear screen and write the replayed buffer
          stdout.write("\x1b[2J\x1b[H");
          stdout.write(packet.payload);
          break;

        case MessageType.EXIT:
          exitCode = decodeExit(packet.payload);
          cleanExit();
          stdout.write(TERMINAL_SANITIZE + `\r\n[session exited with code ${exitCode}]\r\n`);
          options.onExit?.(exitCode);
          return;
      }
    }
  });

  socket.on("error", (err: NodeJS.ErrnoException) => {
    cleanExit();
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      console.error(`Session "${options.name}" not found or not running.`);
    } else {
      console.error(`Connection error: ${err.message}`);
    }
    process.exit(1);
  });

  socket.on("close", () => {
    if (!detaching) {
      cleanExit();
      process.exit(exitCode);
    }
  });
}
