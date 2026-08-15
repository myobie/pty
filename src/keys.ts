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
const MODIFIER_SEPARATORS = /[+_-]/;
const NAMED_KEYS = Object.keys(KEY_MAP).sort().join(", ");
const KEY_SPEC_HELP =
  `Use ctrl+u, ctrl-u, ctrl_u, or C-u; supported modifiers are ctrl, alt, and shift; ` +
  `supported keys are a-z, ${NAMED_KEYS}.`;

/** Keycodes for CSI u encoding (Kitty keyboard protocol). */
const CSI_U_KEYCODES: Record<string, number> = {
  return: 13,
  enter: 13,
  tab: 9,
  escape: 27,
  esc: 27,
  space: 32,
  backspace: 127,
};

/** Compute xterm modifier parameter: 1 + bitmask(shift=1, alt=2, ctrl=4). */
function modifierParam(mods: Set<string>): number {
  return (
    1 +
    (mods.has("shift") ? 1 : 0) +
    (mods.has("alt") ? 2 : 0) +
    (mods.has("ctrl") ? 4 : 0)
  );
}

function normalizeModifier(mod: string, index: number, spec: string): string {
  // Readline/tmux-style C-u is the established compact spelling for ctrl+u.
  // Keep the one-letter alias scoped to a leading C- so C+u and other
  // abbreviated modifier alphabets do not acquire surprise meaning.
  if (mod === "c" && index === 0 && /^c-/i.test(spec)) return "ctrl";
  return mod;
}

function isSupportedBase(base: string): boolean {
  return KEY_MAP[base] !== undefined || (base.length === 1 && base >= "a" && base <= "z");
}

/** Parse a key spec like `ctrl+c`, `ctrl-c`, `C-c`, `return`, or `alt+x` into bytes. */
export function resolveKey(spec: string): string {
  const normalized = spec.toLowerCase();
  const hasSeparator = MODIFIER_SEPARATORS.test(normalized);
  const rawParts = hasSeparator ? normalized.split(MODIFIER_SEPARATORS) : [normalized];
  const rawBase = rawParts.at(-1) ?? "";
  const rawMods = rawParts.slice(0, -1).map((mod, index) =>
    normalizeModifier(mod, index, spec),
  );

  // A separator-bearing name could be both a named key and a modifier chord.
  // Refuse that collision instead of silently changing meaning if the key map
  // ever grows such a name.
  const isValidChord =
    rawBase !== "" &&
    rawMods.length > 0 &&
    rawMods.every((mod) => mod !== "" && MODIFIERS.has(mod)) &&
    isSupportedBase(rawBase);
  if (hasSeparator && KEY_MAP[normalized] !== undefined && isValidChord) {
    throw new Error(
      `Ambiguous key spec "${spec}": it is both a named key and a modifier chord. ${KEY_SPEC_HELP}`,
    );
  }
  if (KEY_MAP[normalized] !== undefined && !isValidChord) return KEY_MAP[normalized];

  const parts = rawParts;
  const base = parts.pop()!;
  if (base === "" || parts.some((part) => part === "")) {
    throw new Error(`Incomplete key spec "${spec}". ${KEY_SPEC_HELP}`);
  }

  const mods = new Set(parts.map((mod, index) => normalizeModifier(mod, index, spec)));

  // Validate modifiers
  for (const mod of mods) {
    if (!MODIFIERS.has(mod)) {
      throw new Error(
        `Unknown modifier: "${mod}" in key spec "${spec}". ${KEY_SPEC_HELP}`,
      );
    }
  }

  const isLetter = base.length === 1 && base >= "a" && base <= "z";
  const hasModifiers = mods.size > 0;
  const mapped = KEY_MAP[base];

  if (mapped === undefined && !isLetter) {
    throw new Error(
      `Unknown key: "${base}" in key spec "${spec}". ` +
        KEY_SPEC_HELP,
    );
  }

  // Single letter keys
  if (isLetter) {
    let result = base;

    if (mods.has("shift")) {
      result = result.toUpperCase();
    }

    if (mods.has("ctrl")) {
      const code = result.toLowerCase().charCodeAt(0);
      result = String.fromCharCode(code - 96);
    }

    if (mods.has("alt")) {
      result = "\x1b" + result;
    }

    return result;
  }

  // Named keys without modifiers: return the mapped value directly
  if (!hasModifiers) {
    return mapped;
  }

  const mod = modifierParam(mods);

  // Special case: shift+tab produces legacy backtab sequence
  if (base === "tab" && mod === 2) {
    return "\x1b[Z";
  }

  // CSI sequences: \x1b[N~ (e.g. delete, pageup) or \x1b[X (e.g. arrows, home, end)
  const csiTilde = mapped.match(/^\x1b\[(\d+)~$/);
  if (csiTilde) {
    return `\x1b[${csiTilde[1]};${mod}~`;
  }

  const csiLetter = mapped.match(/^\x1b\[([A-Z])$/);
  if (csiLetter) {
    return `\x1b[1;${mod}${csiLetter[1]}`;
  }

  // Control char keys (return, tab, escape, space, backspace): use CSI u encoding
  const keycode = CSI_U_KEYCODES[base];
  if (keycode !== undefined) {
    return `\x1b[${keycode};${mod}u`;
  }

  return mapped;
}

/** If value starts with `key:`, resolve the key name; otherwise return the literal string. */
export function parseSeqValue(value: string): string {
  if (value.startsWith("key:")) {
    return resolveKey(value.slice(4));
  }
  return value;
}
