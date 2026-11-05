import assert from "node:assert/strict";
import test from "node:test";

import { spineToolRefusal, spineToolResult } from "../dist/host/children.js";

const node = (id, kind) => ({
  id, parent: id.length > 1 ? id.slice(0, -1) : null, children: [], kind, status: "Live",
  summary: null, memory: null, spawn: null, start: 0, end: null,
});
const projection = (cursor) => ({
  nodes: [node([1], "RootEpoch"), node([1, 1], "Task")],
  cursor, visible_context: [], last_boundary: null,
});

test("spine_close is admitted at an open node and refused at the root", () => {
  assert.equal(spineToolRefusal(projection([1, 1]), "spine_close", new Set(), null, 1), null);
  assert.match(spineToolRefusal(projection([1]), "spine_close", new Set(), null, 1), /You are at the root: no Spine node is open/);
});

test("a Spawn child may not close or leave the node it was spawned in; its own nodes it may", () => {
  // Birth 1.1.2 was spawned in 1.1: its session starts there.
  for (const name of ["spine_close", "spine_next"]) {
    assert.match(spineToolRefusal(projection([1, 1]), name, new Set(), [1, 1, 2], 1), /1\.1 belongs to the session that spawned you/);
  }
  const opened = { ...projection([1, 1, 3]), nodes: [...projection([1, 1, 3]).nodes, node([1, 1, 3], "Task")] };
  assert.equal(spineToolRefusal(opened, "spine_close", new Set(), [1, 1, 2], 1), null);
  // Spawned at the root, the child starts there: the same answer, not the root's.
  assert.match(spineToolRefusal(projection([1]), "spine_close", new Set(), [1, 2], 1), /1 belongs to the session that spawned you/);
});

test("spine_close beside other tool calls is refused; alone it is admitted", () => {
  // The closing sampling folds with the node, so results beside it would be lost.
  assert.match(spineToolRefusal(projection([1, 1]), "spine_close", new Set(), null, 2), /spine_close must be the only tool call/);
  assert.equal(spineToolRefusal(projection([1, 1]), "spine_close", new Set(), null, 1), null);
  // Next keeps its sampling, so the results beside it stay: no refusal.
  assert.equal(spineToolRefusal(projection([1, 1]), "spine_next", new Set(), null, 2), null);
});

test("a Spine call's result says what it has done, with the node it closed and where the model is now", () => {
  const nested = {
    nodes: [node([1], "RootEpoch"), node([1, 1], "Task"), node([1, 1, 2], "Task")],
    cursor: [1, 1, 2], visible_context: [], last_boundary: null,
  };
  assert.equal(spineToolResult(projection([1]), "spine_open", { goal: "A" }), "The node is open.");
  assert.equal(spineToolResult(projection([1, 1]), "spine_close", { memory: "m" }),
    "Node 1.1 is closed and its memory is recorded. You are back at the root.");
  assert.equal(spineToolResult(nested, "spine_close", { memory: "m" }),
    "Node 1.1.2 is closed and its memory is recorded. You are back in node 1.1.");
  assert.equal(spineToolResult(projection([1, 1]), "spine_next", { memory: "m", goal: "B" }),
    "Node 1.1 is closed and its memory is recorded. The next node is open.");
  assert.match(spineToolResult(projection([1]), "spine_spawn", { tasks: [{ summary: "X", prompt: "x" }, { summary: "Y", prompt: "y" }] }),
    /accepted 2 tasks.*arrives later as its own message.*cannot close until all of them have arrived/);
});
