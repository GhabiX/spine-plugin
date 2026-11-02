import assert from "node:assert/strict";
import test from "node:test";

import { spineToolRefusal } from "../dist/host/children.js";

const node = (id, kind) => ({
  id, parent: id.length > 1 ? id.slice(0, -1) : null, children: [], kind, status: "Live",
  summary: null, memory: null, spawn: null, start: 0, end: null,
});
const projection = (cursor) => ({
  nodes: [node([1], "RootEpoch"), node([1, 1], "Task")],
  cursor, visible_context: [], last_boundary: null,
});

test("spine_close beside other tool calls is refused; alone it is admitted", () => {
  const open = projection([1, 1]);
  assert.match(spineToolRefusal(open, "spine_close", new Set(), 2), /spine_close must be the only tool call/);
  assert.equal(spineToolRefusal(open, "spine_close", new Set(), 1), null);
  assert.equal(spineToolRefusal(open, "spine_close", new Set()), null);
  // Next keeps its sampling, so the results beside it stay: no refusal.
  assert.equal(spineToolRefusal(open, "spine_next", new Set(), 2), null);
  // Closing at the root is refused for that reason first.
  assert.match(spineToolRefusal(projection([1]), "spine_close", new Set(), 2), /no open Spine node/);
});
