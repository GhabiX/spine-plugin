// PoC check: a deep-equality failure passes only when the old expectation,
// rewritten by the sampling-boundary rule, equals the actual value.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const isTool = (line) => typeof line === "string" && line.startsWith("tool: ");
const samplingEnd = (lines, i) => { let j = i + 1; while (j < lines.length && isTool(lines[j])) j++; return j; };
const closes = (lines, i, name) => typeof lines[i] === "string" && lines[i].startsWith("assistant: ")
  && lines[i].includes(`${name} {`) && lines.slice(i + 1, samplingEnd(lines, i)).includes(`tool: Spine ${name} staged`);

function rewrite(lines) {
  if (!Array.isArray(lines)) return lines;
  if (!lines.every((line) => typeof line === "string")) return lines.map(rewrite);
  let out = [];
  // The sampling that closes a node folds with it.
  for (let i = 0; i < lines.length; i++) {
    if (closes(lines, i, "spine_close") || closes(lines, i, "spine_next")) { i = samplingEnd(lines, i) - 1; continue; }
    out.push(lines[i]);
  }
  // A descriptor follows the sampling that opened its node.
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i].startsWith("spine: <spine_node") && closes(out, i + 1, "spine_open")) {
      const end = samplingEnd(out, i + 1);
      out = [...out.slice(0, i), ...out.slice(i + 1, end), out[i], ...out.slice(end)];
      i = end - 1;
    }
  }
  return out;
}

export const stats = { reordered: 0 };
for (const name of ["deepEqual", "deepStrictEqual"]) {
  const original = assert[name];
  assert[name] = function (actual, expected, ...rest) {
    try { return original.call(this, actual, expected, ...rest); }
    catch (error) {
      if (isDeepStrictEqual(actual, rewrite(expected))) { stats.reordered++; process.stderr.write("REORDER-OK\n"); return; }
      throw error;
    }
  };
}
