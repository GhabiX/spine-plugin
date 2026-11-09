const ELLIPSIS = "...";

export function visibleWidth(text: string): number {
  let width = 0;
  let index = 0;
  while (index < text.length) {
    const ansi = ansiLength(text, index);
    if (ansi > 0) {
      index += ansi;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    width += codePointWidth(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  let result = "";
  let width = 0;
  let index = 0;
  while (index < text.length) {
    const ansi = ansiLength(text, index);
    if (ansi > 0) {
      result += text.slice(index, index + ansi);
      index += ansi;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const nextWidth = codePointWidth(codePoint);
    if (width + nextWidth > budget) break;
    result += String.fromCodePoint(codePoint);
    width += nextWidth;
    index += codePoint > 0xffff ? 2 : 1;
  }
  result += ellipsis;
  if (text.includes("\x1b")) result += "\x1b[0m";
  return result;
}

export function clampLines(lines: readonly string[], width: number): string[] {
  if (width <= 0) return [];
  return lines.map((line) => truncateToWidth(line, width));
}

/** A Pi TUI component that draws fixed rows, each clamped to the width. */
export function linesComponent(lines: readonly string[]): { render: (width: number) => string[]; invalidate: () => void } {
  return {
    render: (width) => clampLines(lines, width),
    invalidate() {},
  };
}

function ansiLength(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x1b || index + 1 >= text.length) return 0;
  const next = text[index + 1];
  if (next === "[") {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1 - index;
      cursor += 1;
    }
    return text.length - index;
  }
  if (next === "]") {
    let cursor = index + 2;
    while (cursor < text.length) {
      if (text[cursor] === "\x07") return cursor + 1 - index;
      if (text[cursor] === "\x1b" && text[cursor + 1] === "\\") return cursor + 2 - index;
      cursor += 1;
    }
    return text.length - index;
  }
  return 2;
}

function codePointWidth(codePoint: number): number {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
      (codePoint >= 0x30000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}
