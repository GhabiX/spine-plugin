import assert from "node:assert/strict";
import test from "node:test";

import { surfaceEdits } from "../dist/projection.js";

const source = (seq) => ({ seq, role: "source", text: null });
const host = (seq) => ({ seq, role: "host", text: null });
const slot = (seq) => ({ seq, role: "spine", text: null });
const spine = (seq, text) => ({ seq, role: "spine", text });
const at = (seq, anchor = null) => ({ type: "source", seq, anchor });
const item = (text) => ({ type: "spine", text });

/** What the log looks like after the edits; new events take seqs from 100. */
function apply(surface, edits) {
  let next = 100;
  let nodes = [...surface];
  for (const edit of edits) {
    const node = { seq: next++, role: "spine", text: edit.text };
    if (edit.type === "append") {
      nodes.push(node);
      continue;
    }
    const start = nodes.findIndex((candidate) => candidate.seq === edit.startSeq);
    const end = nodes.findIndex((candidate) => candidate.seq === edit.endSeq);
    assert.deepEqual(nodes.slice(start, end + 1).map(({ seq }) => seq), edit.shadowed);
    nodes = [...nodes.slice(0, start), node, ...nodes.slice(end + 1)];
  }
  return nodes;
}

function edited(surface, plan) {
  const after = apply(surface, surfaceEdits(surface, plan));
  assert.deepEqual(surfaceEdits(after, plan), [], "the edited surface already shows the plan");
  return after.map(({ role, seq, text }) => role === "spine" ? text ?? "·" : role === "host" ? `h${seq}` : seq);
}

test("Open puts the descriptor in the two slots in front of the opening response", () => {
  // system, U1, slots, A1, T1
  const surface = [host(0), source(1), slot(2), slot(3), source(4), source(5)];
  assert.deepEqual(edited(surface, [at(1, 1), item("node"), at(4), at(5)]), ["h0", 1, "node", 4, 5]);
});

test("Close replaces the closed span with its memory and keeps the user message in place", () => {
  // U1, desc, A1, T1, U2 (kept), slots, A2 (close), T2
  const surface = [source(1), spine(10, "node"), source(4), source(5), source(6), slot(7), slot(8), source(9), source(11)];
  assert.deepEqual(
    edited(surface, [at(1, 1), at(6, 2), item("memory"), at(9), at(11)]),
    [1, "·", 6, "memory", 9, 11],
  );
});

test("Next gives the memory the leading span and the new descriptor the last slot", () => {
  const surface = [source(1), spine(10, "node A"), source(4), source(5), slot(6), slot(7), source(8), source(9)];
  assert.deepEqual(
    edited(surface, [at(1, 1), item("memory A"), item("node B"), at(8), at(9)]),
    [1, "memory A", "node B", 8, 9],
  );
});

test("host nodes split a span and stay where they are", () => {
  const surface = [source(1), spine(10, "node"), source(4), host(5), source(6), slot(7), slot(8), source(9)];
  assert.deepEqual(edited(surface, [at(1, 1), item("memory"), at(9)]), [1, "·", "h5", "memory", 9]);
});

test("an item after the last source is appended, and stays put once later hosts follow it", () => {
  const surface = [source(1), slot(2), slot(3), source(4), source(5)];
  const plan = [at(1, 1), at(4), at(5), item("birth")];
  // Unused slots stay; they derive no model message.
  assert.deepEqual(edited(surface, plan), [1, "·", "·", 4, 5, "birth"]);
  const later = [source(1), slot(2), slot(3), source(4), source(5), spine(100, "birth"), host(101)];
  assert.deepEqual(surfaceEdits(later, plan), []);
});

test("a plan source missing from the surface, or out of order, is refused", () => {
  const surface = [source(1), source(2)];
  assert.throws(() => surfaceEdits(surface, [at(3)]), /not on the session surface/);
  assert.throws(() => surfaceEdits(surface, [at(2), at(1)]), /not on the session surface/);
  assert.throws(() => surfaceEdits([source(1), spine(2, "x")], [at(2)]), /not on the session surface/);
});

test("more items than a span has nodes is refused rather than misplaced", () => {
  const surface = [source(1), slot(2), source(3)];
  assert.throws(() => surfaceEdits(surface, [at(1), item("a"), item("b"), at(3)]), /do not fit/);
  assert.throws(() => surfaceEdits([source(1), source(3)], [at(1), item("a"), at(3)]), /no surface nodes/);
});
