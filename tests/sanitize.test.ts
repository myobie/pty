import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { TERMINAL_SANITIZE } from "../src/client.ts";

// Helper: write to terminal and wait for processing
function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

// Helper: read the character at a given row/col
function charAt(terminal: Terminal, row: number, col: number): string {
  const line = terminal.buffer.active.getLine(row);
  if (!line) return "";
  const cell = line.getCell(col);
  if (!cell) return "";
  return cell.getChars();
}

// Helper: read a range of characters from a row
function textAt(terminal: Terminal, row: number, startCol: number, len: number): string {
  let result = "";
  for (let i = 0; i < len; i++) {
    result += charAt(terminal, row, startCol + i);
  }
  return result;
}

describe("TERMINAL_SANITIZE resets poisoned terminal modes", () => {
  // ─── Autowrap (DECAWM) ───
  //
  // TUI apps sometimes disable line wrapping (\x1b[?7l) so that long lines
  // are truncated at the right margin instead of wrapping. If not re-enabled,
  // the user's shell output won't wrap — text past the terminal width is lost.

  it("re-enables autowrap (DECAWM) after it was disabled", async () => {
    const t = new Terminal({ rows: 10, cols: 5, allowProposedApi: true });
    await write(t, "\x1b[?7l"); // disable autowrap
    await write(t, TERMINAL_SANITIZE);

    // Write 6 characters into a 5-column terminal.
    // With autowrap ON: "12345" on row 0, "X" on row 1.
    // With autowrap OFF: "1234X" on row 0 (last char overwrites), nothing on row 1.
    await write(t, "12345X");

    expect(charAt(t, 1, 0)).toBe("X");
    t.dispose();
  });

  // ─── DEC Special Graphics character set ───
  //
  // Programs that draw box-drawing lines (e.g., borders in TUI dashboards)
  // switch G0 to DEC Special Graphics via \x1b(0. In this character set,
  // ASCII letters map to line-drawing symbols (e.g., 'q' → '─', 'a' → '▒').
  // If not reset to ASCII (\x1b(B), typing in the shell produces box chars.

  it("resets G0 character set to ASCII after DEC line drawing was enabled", async () => {
    const t = new Terminal({ rows: 10, cols: 20, allowProposedApi: true });
    await write(t, "\x1b(0"); // switch G0 to DEC Special Graphics
    await write(t, TERMINAL_SANITIZE);

    // Write regular ASCII. If charset is still DEC line drawing:
    //   'a' → '▒', 'q' → '─', 'j' → '┘'
    // If charset was properly reset to ASCII:
    //   'a' → 'a', 'q' → 'q', 'j' → 'j'
    await write(t, "aqj");

    expect(charAt(t, 0, 0)).toBe("a");
    expect(charAt(t, 0, 1)).toBe("q");
    expect(charAt(t, 0, 2)).toBe("j");
    t.dispose();
  });

  // ─── Insert mode (IRM) ───
  //
  // Insert mode (\x1b[4h) causes newly written characters to push existing
  // characters to the right instead of overwriting them. If left on, shell
  // output would insert instead of overwrite, producing garbled display.

  it("resets insert mode (IRM) to replace mode", async () => {
    const t = new Terminal({ rows: 10, cols: 20, allowProposedApi: true });
    await write(t, "\x1b[4h"); // enable insert mode
    await write(t, TERMINAL_SANITIZE);

    // Write "AB", then move cursor back to column 0 and write "X".
    // Replace mode (default): row 0 = "XB"
    // Insert mode: row 0 = "XAB"
    await write(t, "AB");
    await write(t, "\x1b[1;1H"); // cursor to row 1, col 1 (home)
    await write(t, "X");

    expect(charAt(t, 0, 0)).toBe("X");
    expect(charAt(t, 0, 1)).toBe("B");
    expect(charAt(t, 0, 2)).toBe(""); // should be empty in replace mode
    t.dispose();
  });

  // ─── Origin mode (DECOM) + scroll region (DECSTBM) ───
  //
  // Origin mode (\x1b[?6h) makes cursor positioning relative to the scroll
  // region instead of the full screen. Combined with a scroll region
  // (\x1b[<top>;<bottom>r), cursor home goes to the top of the region, not
  // the top of the screen. If left set, cursor addressing is wrong.

  it("resets origin mode and scroll region", async () => {
    const t = new Terminal({ rows: 10, cols: 20, allowProposedApi: true });
    await write(t, "\x1b[3;8r"); // scroll region: rows 3-8
    await write(t, "\x1b[?6h"); // enable origin mode
    await write(t, TERMINAL_SANITIZE);

    // Move to "home" position
    await write(t, "\x1b[H");
    await write(t, "X");

    // With origin mode OFF and no scroll region:
    //   \x1b[H goes to row 0, col 0 (absolute top-left)
    // With origin mode ON and scroll region 3-8:
    //   \x1b[H goes to row 2 (0-indexed), col 0 (top of scroll region)
    expect(charAt(t, 0, 0)).toBe("X");
    t.dispose();
  });

  // ─── Scroll region alone (DECSTBM) ───
  //
  // Even without origin mode, a leftover scroll region restricts where
  // scrolling happens. New output at the bottom would only scroll within the
  // region, leaving lines above and below frozen.

  it("resets scroll region to full terminal", async () => {
    const t = new Terminal({ rows: 10, cols: 20, allowProposedApi: true });
    await write(t, "\x1b[3;5r"); // restrict scrolling to rows 3-5
    await write(t, TERMINAL_SANITIZE);

    // Write "MARKER" on row 3 (1-indexed), which is inside the old scroll region.
    await write(t, "\x1b[3;1H");
    await write(t, "MARKER");

    // Move to row 5 (1-indexed) — the old scroll region's bottom row.
    // Write a newline:
    //   If scroll region was reset (full terminal): cursor moves to row 6,
    //   no scrolling occurs (not at terminal bottom), MARKER stays on row 3.
    //   If scroll region is still 3-5: cursor is at bottom of region, newline
    //   scrolls within the region, MARKER is pushed off the top of the region.
    await write(t, "\x1b[5;1H");
    await write(t, "\n");
    await write(t, "BELOW");

    // MARKER should still be at row 2 (0-indexed) if scroll region was reset
    expect(textAt(t, 2, 0, 6)).toBe("MARKER");
    // BELOW should be at row 4 (0-indexed = row 5 in 1-indexed, after \n moved to row 6 → 0-indexed 5)
    expect(textAt(t, 5, 0, 5)).toBe("BELOW");
    t.dispose();
  });

  // ─── Application keypad mode (DECKPAM) ───
  //
  // Application keypad mode (\x1b=) changes numpad key sequences from normal
  // numbers to application-mode escape sequences. If left on, pressing numpad
  // keys in the shell produces escape sequences instead of numbers.
  // Testing this behaviorally is hard, so verify TERMINAL_SANITIZE includes
  // the reset sequence \x1b> (DECKPNM — normal keypad mode).

  it("includes application keypad mode reset (DECKPNM)", () => {
    expect(TERMINAL_SANITIZE).toContain("\x1b>");
  });

  // ─── Focus event reporting ───
  //
  // Focus reporting (\x1b[?1004h) tells the terminal to send \x1b[I (focus in)
  // and \x1b[O (focus out) events. If left on, switching terminal windows/tabs
  // produces garbage escape sequences in the shell.

  it("disables focus event reporting", () => {
    expect(TERMINAL_SANITIZE).toContain("\x1b[?1004l");
  });

  // ─── Cursor style ───
  //
  // Programs like vim change cursor style (e.g., \x1b[6 q for bar cursor in
  // insert mode). If not reset, the user's cursor stays as a bar/underline
  // instead of reverting to the terminal's default style.

  it("resets cursor style to terminal default", () => {
    // \x1b[0 q or \x1b[ q resets cursor to user's default
    const hasReset =
      TERMINAL_SANITIZE.includes("\x1b[0 q") ||
      TERMINAL_SANITIZE.includes("\x1b[ q");
    expect(hasReset).toBe(true);
  });
});
