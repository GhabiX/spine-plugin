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

test("spine_close is admitted at an open node and refused at the root", () => {
  assert.equal(spineToolRefusal(projection([1, 1]), "spine_close", new Set()), null);
  assert.match(spineToolRefusal(projection([1]), "spine_close", new Set()), /no open Spine node/);
});
