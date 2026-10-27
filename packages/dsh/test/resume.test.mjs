// A restarted process resumes a persisted session: Spine state comes back from
// the session log alone, and the next request still shows the plan.
import assert from "node:assert/strict";
import test from "node:test";

import { mountDsh } from "./harness.mjs";
import { call, memory, node, shown, staged } from "./shown.mjs";

/** Run `before` in one world, then resume the same session in a new one and run `after`. */
async function restart(before, after, drive) {
  const first = await mountDsh(before);
  let id;
  try {
    id = (await first.run("start")).id;
  } finally {
    await first.dispose();
  }
  const second = await mountDsh(after, { root: first.root });
  try {
    const agent = await second.resume(id);
    await drive(second, agent);
    assert.deepEqual(await second.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
    return {
      requests: second.adapter.requests.map(shown),
      ends: agent.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind),
    };
  } finally {
    await second.dispose();
  }
}

test("a resumed session keeps its open node, user numbering and Close", async () => {
  const run = await restart(
    [[["spine_open", { goal: "A" }]], "replyA"],
    [[["spine_close", { memory: "memA" }]], "done"],
    (dsh, agent) => dsh.send(agent, "more"),
  );
  assert.deepEqual(run.ends, ["completed", "completed"]);
  assert.deepEqual(run.requests, [
    ["user: [U1]\nstart", node("1.1", "A"), call("spine_open", { goal: "A" }), staged("spine_open"), "assistant: replyA", "user: [U2]\nmore"],
    ["user: [U1]\nstart", "assistant: replyA", "user: [U2]\nmore", memory("1.1", "memA"), call("spine_close", { memory: "memA" }), staged("spine_close")],
  ]);
});

test("a sampling that began but never committed replays as abandoned", async () => {
  const run = await restart(
    [[["spine_open", { goal: "A" }]], { fail: "boom" }],
    ["ok"],
    (dsh, agent) => dsh.send(agent, "again"),
  );
  assert.deepEqual(run.ends, ["error", "completed"]);
  assert.deepEqual(run.requests, [
    ["user: [U1]\nstart", node("1.1", "A"), call("spine_open", { goal: "A" }), staged("spine_open"), "user: [U2]\nagain"],
  ]);
});

test("a session that started without Spine is refused, not adopted with unnumbered users", async () => {
  const first = await mountDsh(["hello"], { plugin: false });
  let id;
  try {
    id = (await first.run("hi")).id;
  } finally {
    await first.dispose();
  }
  const second = await mountDsh([], { root: first.root });
  try {
    await assert.rejects(second.resume(id), /started without Spine/);
  } finally {
    await second.dispose();
  }
});
