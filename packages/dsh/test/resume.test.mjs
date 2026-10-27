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

test("a failed sampling replays as failed: the Open it staged is not committed", async () => {
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

/**
 * Run `turns` in one world, and again in a new world before every turn that
 * resumes the session; `setup` prepares each world.
 */
async function bothWays(turns, setup = () => {}) {
  const once = await mountDsh(turns.flatMap(([, replies]) => replies));
  setup(once);
  let continuous;
  try {
    const agent = await once.run(turns[0][0]);
    for (const [text] of turns.slice(1)) await once.send(agent, text);
    continuous = { requests: once.adapter.requests.map(shown), ends: ends(agent) };
  } finally {
    await once.dispose();
  }

  const requests = [];
  let root;
  let id;
  let last;
  for (const [index, [text, replies]] of turns.entries()) {
    const dsh = await mountDsh(replies, { root });
    setup(dsh);
    try {
      if (index === 0) {
        id = (await dsh.run(text)).id;
      } else {
        const agent = await dsh.resume(id);
        await dsh.send(agent, text);
        last = ends(agent);
        assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
      }
      requests.push(...dsh.adapter.requests.map(shown));
      root = dsh.root;
    } finally {
      await dsh.dispose();
    }
  }
  return { continuous, restarted: { requests, ends: last } };
}

test("restarting before every turn changes nothing the model sees", async () => {
  const { continuous, restarted } = await bothWays([
    ["start", [[["spine_open", { goal: "A" }]], "r1"]],
    ["more", [[["spine_next", { memory: "mA", goal: "B" }]], { fail: "boom" }]],
    ["again", [{ text: "cut", finish: "max-tokens" }]],
    ["last", [[["spine_open", { goal: "C" }]], [["spine_close", { memory: "mC" }]], [["spine_close", { memory: "mB" }]], "done"]],
  ]);
  assert.deepEqual(continuous.ends, ["completed", "error", "max-tokens", "completed"]);
  assert.deepEqual(restarted, continuous);
});

test("a Spine call whose result another extension turns into an error commits nothing", async () => {
  const { continuous, restarted } = await bothWays(
    [["start", [[["spine_open", { goal: "A" }]], "done"]], ["more", ["ok"]]],
    (dsh) => dsh.ctx.on("tools/post-execute", (exec, result, next) => exec.name === "spine_open"
      ? Promise.resolve({ kind: "block", feedback: [{ type: "text", text: "blocked" }] })
      : next()),
  );
  assert.deepEqual(restarted, continuous);
  assert.deepEqual(continuous.requests[1], ["user: [U1]\nstart", call("spine_open", { goal: "A" }), "tool: blocked"]);
  assert.ok(!continuous.requests.flat().includes(node("1.1", "A")));
});

test("a Stop after the response was logged: live and resumed sessions agree, and its reply survives Close", async () => {
  const { continuous, restarted } = await bothWays(
    [
      ["start", [[["spine_open", { goal: "A" }]], "replyA"]],
      ["more", [[["spine_close", { memory: "mA" }]], "done"]],
    ],
    (dsh) => dsh.ctx.on("agent/turn-stopping", ({ agent }) => {
      const last = agent.session.snapshotEvents().findLast((event) => event.type === "assistant/message");
      if (last.data.message.content[0].text === "replyA") agent.cancel({ kind: "user" });
    }),
  );
  assert.deepEqual(continuous.ends, ["aborted", "completed"]);
  assert.deepEqual(restarted, continuous);
  assert.ok(continuous.requests.at(-1).includes("assistant: replyA"));
});

test("a stream that ends without a finish chunk stopped by itself: its reply survives Close", async () => {
  const { continuous, restarted } = await bothWays([
    ["start", [[["spine_open", { goal: "A" }]], { text: "replyA", finish: null }]],
    ["more", [[["spine_close", { memory: "mA" }]], "done"]],
  ]);
  assert.deepEqual(restarted, continuous);
  assert.deepEqual(continuous.requests.at(-1), [
    "user: [U1]\nstart", "assistant: replyA", "user: [U2]\nmore", memory("1.1", "mA"), call("spine_close", { memory: "mA" }), staged("spine_close"),
  ]);
});

function ends(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind);
}
