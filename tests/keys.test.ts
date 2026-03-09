import { describe, it, expect } from "vitest";
import { resolveKey, parseSeqValue } from "../src/keys.ts";

describe("resolveKey", () => {
  it("resolves named keys", () => {
    expect(resolveKey("return")).toBe("\r");
    expect(resolveKey("enter")).toBe("\r");
    expect(resolveKey("tab")).toBe("\t");
    expect(resolveKey("escape")).toBe("\x1b");
    expect(resolveKey("esc")).toBe("\x1b");
    expect(resolveKey("space")).toBe(" ");
    expect(resolveKey("backspace")).toBe("\x7f");
    expect(resolveKey("delete")).toBe("\x1b[3~");
  });

  it("resolves arrow keys", () => {
    expect(resolveKey("up")).toBe("\x1b[A");
    expect(resolveKey("down")).toBe("\x1b[B");
    expect(resolveKey("right")).toBe("\x1b[C");
    expect(resolveKey("left")).toBe("\x1b[D");
  });

  it("resolves navigation keys", () => {
    expect(resolveKey("home")).toBe("\x1b[H");
    expect(resolveKey("end")).toBe("\x1b[F");
    expect(resolveKey("pageup")).toBe("\x1b[5~");
    expect(resolveKey("pagedown")).toBe("\x1b[6~");
  });

  it("resolves ctrl chords", () => {
    expect(resolveKey("ctrl+c")).toBe("\x03");
    expect(resolveKey("ctrl+a")).toBe("\x01");
    expect(resolveKey("ctrl+z")).toBe("\x1a");
    expect(resolveKey("ctrl+d")).toBe("\x04");
  });

  it("resolves alt chords", () => {
    expect(resolveKey("alt+x")).toBe("\x1bx");
    expect(resolveKey("alt+a")).toBe("\x1ba");
  });

  it("resolves shift chords", () => {
    expect(resolveKey("shift+a")).toBe("A");
    expect(resolveKey("shift+z")).toBe("Z");
  });

  it("resolves composed modifiers", () => {
    expect(resolveKey("ctrl+alt+c")).toBe("\x1b\x03");
    expect(resolveKey("alt+ctrl+c")).toBe("\x1b\x03");
  });

  it("is case insensitive", () => {
    expect(resolveKey("Ctrl+C")).toBe("\x03");
    expect(resolveKey("RETURN")).toBe("\r");
    expect(resolveKey("Alt+X")).toBe("\x1bx");
  });

  it("throws on unknown key", () => {
    expect(() => resolveKey("f99")).toThrow(/Unknown key/);
    expect(() => resolveKey("nonexistent")).toThrow(/Unknown key/);
  });

  it("throws on unknown modifier", () => {
    expect(() => resolveKey("super+c")).toThrow(/Unknown modifier/);
    expect(() => resolveKey("meta+x")).toThrow(/Unknown modifier/);
  });
});

describe("parseSeqValue", () => {
  it("resolves key: prefixed values", () => {
    expect(parseSeqValue("key:return")).toBe("\r");
    expect(parseSeqValue("key:ctrl+c")).toBe("\x03");
    expect(parseSeqValue("key:tab")).toBe("\t");
  });

  it("passes through literal strings", () => {
    expect(parseSeqValue("hello")).toBe("hello");
    expect(parseSeqValue("git status")).toBe("git status");
    expect(parseSeqValue("")).toBe("");
  });
});
