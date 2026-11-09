import assert from "node:assert/strict";
import test from "node:test";

import { clampLines, linesComponent, truncateToWidth, visibleWidth } from "../dist/pi/tui-width.js";

test("visible width treats CJK as two columns and ignores ANSI", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("分析"), 4);
  assert.equal(visibleWidth("\x1b[38;5;109m◉\x1b[39m 分析"), 1 + 1 + 4);
});

test("truncateToWidth clips the Spine tree line that crashed PI", () => {
  const line =
    "\x1b[38;5;241m  └ \x1b[39m\x1b[38;5;109m\x1b[1m◉\x1b[22m\x1b[39m 分析 SpineTree agent 无法 spawn 的原因（对照 2031 轨迹、instruction、host 工具与运行约束）";
  assert.equal(visibleWidth(line) > 85, true);
  const clipped = truncateToWidth(line, 85);
  assert.equal(visibleWidth(clipped) <= 85, true);
  assert.equal(clipped.includes("..."), true);
});

test("linesComponent clamps every rendered row to the given width", () => {
  const component = linesComponent([
    "  └ ◉ 分析 SpineTree agent 无法 spawn 的原因（对照 2031 轨迹、instruction、host 工具与运行约束）",
  ]);
  const [rendered] = component.render(85);
  assert.equal(visibleWidth(rendered) <= 85, true);
});

test("clampLines leaves short rows unchanged", () => {
  assert.deepEqual(clampLines(["• Spine Tree"], 85), ["• Spine Tree"]);
});
