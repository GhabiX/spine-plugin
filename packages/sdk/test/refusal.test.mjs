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
  assert.equal(spineToolRefusal(projection([1, 1]), "spine_close", new Set(), null), null);
  assert.match(spineToolRefusal(projection([1]), "spine_close", new Set(), null), /no open Spine node/);
});

test("a Spawn child may not close or leave the node it was spawned in; its own nodes it may", () => {
  // Birth 1.1.2 was spawned in 1.1: its session starts there.
  for (const name of ["spine_close", "spine_next"]) {
    assert.match(spineToolRefusal(projection([1, 1]), name, new Set(), [1, 1, 2]), /1\.1 belongs to the session that spawned you/);
  }
  const opened = { ...projection([1, 1, 3]), nodes: [...projection([1, 1, 3]).nodes, node([1, 1, 3], "Task")] };
  assert.equal(spineToolRefusal(opened, "spine_close", new Set(), [1, 1, 2]), null);
});
