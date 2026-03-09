const KEY_MAP: Record<string, string> = {
  return: "\r",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  esc: "\x1b",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
};

const MODIFIERS = new Set(["ctrl", "alt", "shift"]);

/** Parse a key spec like `ctrl+c`, `return`, `alt+x` into bytes. */
export function resolveKey(spec: string): string {
  const parts = spec.toLowerCase().split("+");
  const base = parts.pop()!;
  const mods = new Set(parts);

  // Validate modifiers
  for (const mod of mods) {
    if (!MODIFIERS.has(mod)) {
      throw new Error(`Unknown modifier: "${mod}" in key spec "${spec}"`);
    }
  }

  let result: string;

  if (KEY_MAP[base] !== undefined) {
    result = KEY_MAP[base];
  } else if (base.length === 1 && base >= "a" && base <= "z") {
    result = base;
  } else {
    throw new Error(`Unknown key: "${base}" in key spec "${spec}"`);
  }

  // Apply shift (only meaningful for single letters)
  if (mods.has("shift")) {
    if (result.length === 1 && result >= "a" && result <= "z") {
      result = result.toUpperCase();
    }
    // shift on non-letters is silently ignored (e.g. shift+return = return)
  }

  // Apply ctrl (only meaningful for single letters)
  if (mods.has("ctrl")) {
    if (result.length === 1) {
      const code = result.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) {
        result = String.fromCharCode(code - 96);
      }
    }
  }

  // Apply alt (prefix with ESC)
  if (mods.has("alt")) {
    result = "\x1b" + result;
  }

  return result;
}

/** If value starts with `key:`, resolve the key name; otherwise return the literal string. */
export function parseSeqValue(value: string): string {
  if (value.startsWith("key:")) {
    return resolveKey(value.slice(4));
  }
  return value;
}
