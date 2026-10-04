// The colour scheme, in one place.
//
// Renderers never name a raw colour: they ask the theme for a role
// (`tool`, `ok`, `diffAdd`, …), so the whole UI stays coherent and a plain
// terminal simply gets uncoloured text. Depth is negotiated once from the
// environment: 24-bit where available, 256 where available, 16 otherwise.

import { colorDepth, createStyle, stripAnsi, visibleWidth } from "./ansi.js";

export const THEME_ROLES = [
  "accent",
  "accent2",
  "text",
  "muted",
  "faint",
  "border",
  "borderFocus",
  "user",
  "tool",
  "ok",
  "err",
  "warn",
  "info",
  "code",
  "diffAdd",
  "diffDel",
  "gold",
];

/**
 * @param {{color?: boolean, depth?: number, symbols?: Record<string,string>}} [options]
 */
export function createTheme(options = {}) {
  const wants = options.color !== false;
  const depth = options.depth ?? colorDepth();
  const paint = createStyle(wants, { depth });
  const use = wants && paint.depth > 0;

  const roles = {};
  for (const role of THEME_ROLES) roles[role] = (text) => (use ? paint.color(role, text) : String(text ?? ""));

  const meter = (percent, text) => {
    if (!use) return String(text ?? "");
    const value = Number(percent) || 0;
    const role = value >= 90 ? "err" : value >= 70 ? "warn" : value >= 45 ? "gold" : "ok";
    return paint.color(role, text);
  };

  const badge = (label, role = "muted") => {
    if (!use) return `[${label}]`;
    return paint.color(role, `[${label}]`);
  };

  return {
    use,
    depth: paint.depth,
    paint,
    roles,
    ...roles,
    bold: paint.bold,
    dim: paint.dim,
    italic: paint.italic,
    underline: paint.underline,
    inverse: paint.inverse,
    bg: paint.bg,
    meter,
    badge,
    /** Colour a single line of a unified diff, or leave it alone. */
    diffLine(line) {
      const text = String(line ?? "");
      if (!use) return text;
      if (text.startsWith("+++") || text.startsWith("---")) return paint.bold(text);
      if (text.startsWith("@@")) return roles.info(text);
      if (text.startsWith("+")) return roles.diffAdd(text);
      if (text.startsWith("-")) return roles.diffDel(text);
      return paint.dim(text);
    },
  };
}

/** A theme that never emits an escape sequence. */
export function plainTheme() {
  return createTheme({ color: false, depth: 0 });
}

/** Visible width helper re-exported for renderers that measure their output. */
export { stripAnsi, visibleWidth };
