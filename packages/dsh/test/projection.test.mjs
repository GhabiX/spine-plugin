import assert from "node:assert/strict";
import test from "node:test";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";

import { emptySlot, eventMessage, spineText, surfaceRole } from "../dist/events.js";
import { applySurfaceEdits, surfaceEdits } from "../dist/projection.js";

const source = (seq) => ({ seq, role: "source", text: null });
const host = (seq) => ({ seq, role: "host", text: null });
const slot = (seq) => ({ seq, role: "spine", text: null });
const spine = (seq, text) => ({ seq, role: "spine", text });
const at = (seq, anchor = null) => ({ type: "source", seq, anchor, withoutReasoning: false });
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

test("An item fills the slots in front of the source that follows it", () => {
  // system, U1, slots, A1, T1
  const surface = [host(0), source(1), slot(2), slot(3), source(4), source(5)];
  assert.deepEqual(edited(surface, [at(1, 1), item("node"), at(4), at(5)]), ["h0", 1, "node", "·", 4, 5]);
});

test("Close replaces the closed span with its memory and keeps the user message in place", () => {
  // U1, desc, A1, T1, U2 (kept), slots, A2 (close), T2
  const surface = [source(1), spine(10, "node"), source(4), source(5), source(6), slot(7), slot(8), source(9), source(11)];
  assert.deepEqual(
    edited(surface, [at(1, 1), at(6, 2), item("memory"), at(9), at(11)]),
    [1, "·", "·", "·", 6, "memory", "·", 9, 11],
  );
});

test("two items share a run without consuming its remaining positions", () => {
  const surface = [source(1), spine(10, "node A"), source(4), source(5), slot(6), slot(7), source(8), source(9)];
  assert.deepEqual(
    edited(surface, [at(1, 1), item("memory A"), item("node B"), at(8), at(9)]),
    [1, "memory A", "node B", "·", "·", "·", 8, 9],
  );
});

test("host nodes split a span and stay where they are", () => {
  const surface = [source(1), spine(10, "node"), source(4), host(5), source(6), slot(7), slot(8), source(9)];
  assert.deepEqual(edited(surface, [at(1, 1), item("memory"), at(9)]), [1, "·", "·", "h5", "memory", "·", "·", 9]);
});

test("an item after the last source is appended, and stays put once later hosts follow it", () => {
  const surface = [source(1), slot(2), slot(3), source(4), source(5)];
  const plan = [at(1, 1), at(4), at(5), item("birth")];
  // Unused slots stay; they derive no model message.
  assert.deepEqual(edited(surface, plan), [1, "·", "·", 4, 5, "birth"]);
  const later = [source(1), slot(2), slot(3), source(4), source(5), spine(100, "birth"), host(101)];
  assert.deepEqual(surfaceEdits(later, plan), []);
});

test("an existing visible summary stays put when the next item fits after it", () => {
  const surface = [source(1), slot(2), spine(3, "child"), slot(4), source(5)];
  const plan = [at(1), item("child"), item("parent"), at(5)];
  const edits = surfaceEdits(surface, plan);
  assert.deepEqual(edits, [{ type: "replace", startSeq: 4, endSeq: 4, shadowed: [4], text: "parent" }]);
  assert.deepEqual(edited(surface, plan), [1, "·", "child", "parent", 5]);
});

test("nested summaries expand into preserved slots and survive DSH session replay", () => {
  let session = Session.create("projection-replay");
  function logUser(text) {
    return session.append("user/message", createUserMessage({
      content: [{ type: "text", text }], source: { kind: "user" },
    }), { surfaceOp: "append" });
  }
  const start = logUser("before").seq;
  logUser("closed branch event A");
  session.append("developer/message", { turn: 1, step: 1, message: emptySlot() }, { surfaceOp: "append" });
  logUser("closed branch event B");
  const end = logUser("after").seq;
  const original = session.snapshotEvents();
  function surface() {
    return session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq);
      const role = surfaceRole(event);
      return { seq, role, text: role === "spine" ? spineText(eventMessage(event)) : null };
    });
  }
  const summaries = [item("child"), item("parent"), item("grandparent")];
  for (let count = 1; count <= summaries.length; count += 1) {
    const selected = summaries.slice(0, count);
    const plan = [at(start), ...selected, at(end)];
    const messagesBefore = session.deriveMessages();
    const edits = surfaceEdits(surface(), plan);
    if (count > 1) assert.equal(edits.length, 1, "only the newly used position changes");
    const logLength = session.snapshotEvents().length;
    applySurfaceEdits(session, edits, 1, 1);
    const beforeTokens = messagesBefore.reduce((tokens, message) => tokens + estimateMessage(message), 0);
    const recorded = session.snapshotEvents().slice(logLength);
    assert.equal(recorded.length, edits.length * 2, "each replacement has one adjacent price event");
    let delta = 0;
    for (let index = 0; index < recorded.length; index += 2) {
      const claim = recorded[index];
      const replacement = recorded[index + 1];
      assert.equal(claim.type, "compaction/prune");
      assert.deepEqual(claim.data.shadowedRange,
        { start: replacement.surfaceOp.startSeq, end: replacement.surfaceOp.endSeq });
      delta += (replacement.type === "developer/message" ? 0 : estimateMessage(replacement.data))
        - claim.data.shadowedTokenCount;
    }
    const messages = session.deriveMessages();
    assert.equal(beforeTokens + delta, messages.reduce((tokens, message) => tokens + estimateMessage(message), 0));
    assert.deepEqual(messages.map((message) => message.content[0]?.text),
      ["before", ...selected.map(({ text }) => text), "after"]);
    if (count > 1) assert.deepEqual(messages.slice(0, -2), messagesBefore.slice(0, -1));
    assert.deepEqual(session.snapshotEvents().slice(0, original.length), original, "the original transcript is kept");
    session = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header);
    assert.deepEqual(session.deriveMessages(), messages, "replay reconstructs each separate message");
    assert.deepEqual(surfaceEdits(surface(), plan), [], "reapplying after replay is a no-op");
  }
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
