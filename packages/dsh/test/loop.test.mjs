// Spine on the production DSH AgentLoop with a scripted model. The plugin
// itself refuses any model request that differs from its Spine plan, so a
// turn that completes also proves every request in it showed the plan.
import assert from "node:assert/strict";
import test from "node:test";

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { mountDsh } from "./harness.mjs";
import { call, memory, node, shown, staged, closed } from "./shown.mjs";

async function scenario(replies, drive) {
  const dsh = await mountDsh(typeof replies === "function" ? replies(() => dsh) : replies);
  try {
    const agent = await drive(dsh);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
    return {
      requests: dsh.adapter.requests.map(shown),
      ends: dsh.events(agent).filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind),
      samplings: dsh.events(agent).filter((event) => event.type === "developer/message" && event.data.message.source.sampling === true).length,
      events: dsh.events(agent),
    };
  } finally {
    await dsh.dispose();
  }
}

test("Open shows the node; Close shows its call, then its memory", async () => {
  const run = await scenario(
    [[["spine_open", { goal: "inspect" }]], [["spine_close", { memory: "found it" }]], "done"],
    (dsh) => dsh.run("start"),
  );
  assert.deepEqual(run.ends, ["completed"]);
  assert.deepEqual(run.requests, [
    ["user: [U1]\nstart", "context: …"],
    ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "inspect" }), staged("spine_open"), node("1.1", "inspect")],
    ["user: [U1]\nstart", "context: …", closed("1.1", "inspect"), memory("1.1", "found it")],
  ]);
  assert.equal(run.samplings, 3);
});

test("Next, nesting and a second user turn: Close keeps user messages, replies and child memories", async () => {
  const run = await scenario([
    [["spine_open", { goal: "A" }]],
    [["spine_next", { memory: "memA", goal: "B" }]],
    "reply1",
    [["spine_open", { goal: "C" }]],
    [["spine_close", { memory: "memC" }]],
    [["spine_close", { memory: "memB" }]],
    "reply2",
  ], async (dsh) => {
    const agent = await dsh.run("start");
    await dsh.send(agent, "more");
    return agent;
  });
  assert.deepEqual(run.ends, ["completed", "completed"]);
  const next = [call("spine_next", { memory: "memA", goal: "B" }), staged("spine_next")];
  assert.deepEqual(run.requests[2], ["user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), ...next, node("1.2", "B")]);
  assert.deepEqual(run.requests[4], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), ...next, node("1.2", "B"), "assistant: reply1",
    "user: [U2]\nmore", call("spine_open", { goal: "C" }), staged("spine_open"), node("1.2.1", "C"),
  ]);
  assert.deepEqual(run.requests[6], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), closed("1.2", "B"), "assistant: reply1", "user: [U2]\nmore", memory("1.2.1", "memC"),
    memory("1.2", "memB"),
  ]);
});

test("a sampling that closed a node shows without its reasoning; the opening one keeps it", async () => {
  const run = await scenario([
    { reasoning: "why open", calls: [["spine_open", { goal: "A" }]] },
    { reasoning: "why next", calls: [["spine_next", { memory: "memA", goal: "B" }], ["probe", {}]] },
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const open = `assistant: <reasoning>${call("spine_open", { goal: "A" }).slice("assistant: ".length)}`;
  assert.deepEqual(run.requests[1], ["user: [U1]\nstart", "context: …", open, staged("spine_open"), node("1.1", "A")]);
  // The Next sampling belongs to node 1.2: its other result stays; it lost its reasoning.
  assert.deepEqual(run.requests[2].slice(0, 5), ["user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"),
    "assistant: spine_next {\"memory\":\"memA\",\"goal\":\"B\"}probe {}"]);
  assert.equal(run.requests[2].at(-1), node("1.2", "B"));
  assert.equal(run.events.filter((event) => event.type === "plugin:spinejit/without-reasoning").length, 1);
});

const probeTool = {
  name: "probe",
  description: "Probe.",
  parameters: { type: "object", properties: {} },
  output: { schema: { type: "object", properties: {} }, render: () => [{ type: "text", text: "probed" }] },
  execute: async () => ({}),
};

test("runtime context DSH adds inside a node stays in place when the node closes", async () => {
  const run = await scenario((dsh) => [
    [["spine_open", { goal: "A" }]],
    () => {
      dsh().ctx.tools.register(probeTool);
      dsh().ctx.systemPrompt.context({ name: "probe", order: 150, text: "probe context" });
      return [["probe", {}]];
    },
    [["spine_close", { memory: "memA" }]],
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  assert.equal(run.requests[2].at(-1), "context: …", "DSH added runtime context inside node A");
  assert.deepEqual(run.requests[3], [
    "user: [U1]\nstart", "context: …", "context: …", closed("1.1", "A"),
    memory("1.1", "memA"),
  ]);
});

test("spine_close beside another tool call is a tool error; called alone it closes", async () => {
  const run = await scenario((dsh) => [
    [["spine_open", { goal: "A" }]],
    () => {
      dsh().ctx.tools.register(probeTool);
      return [["spine_close", { memory: "memA" }], ["probe", {}]];
    },
    [["spine_close", { memory: "memA" }]],
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const results = run.events.filter((event) => event.type === "tool/result").map((event) => event.data.message);
  assert.deepEqual(results.map((message) => message.isError === true), [false, true, false, false]);
  assert.match(results[1].content[0].text, /spine_close must be the only tool call in its response/);
  assert.deepEqual(run.requests[3], ["user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA")]);
});

test("a failed request and a cancelled one leave the plan as it was", async () => {
  for (const interrupt of [{ fail: "boom" }, (dsh) => {
    setTimeout(() => dsh().agent.cancel({ kind: "user" }), 10);
    return { hang: true };
  }]) {
    const run = await scenario((dsh) => [
      [["spine_open", { goal: "A" }]],
      typeof interrupt === "function" ? () => interrupt(dsh) : interrupt,
      "ok",
    ], async (dsh) => {
      const agent = await dsh.run("start");
      await dsh.send(agent, "again");
      return agent;
    });
    assert.deepEqual(run.ends, [typeof interrupt === "function" ? "aborted" : "error", "completed"]);
    assert.deepEqual(run.requests[2], [
      "user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), staged("spine_open"), node("1.1", "A"), "user: [U2]\nagain",
    ]);
    assert.equal(run.samplings, 3);
  }
});

test("text cut off at max tokens is no reply: Close folds it into the node", async () => {
  const run = await scenario(
    [[["spine_open", { goal: "A" }]], { text: "partial", finish: "max-tokens" }, [["spine_close", { memory: "m" }]], "done"],
    async (dsh) => {
      const agent = await dsh.run("start");
      await dsh.send(agent, "more");
      return agent;
    },
  );
  assert.deepEqual(run.ends, ["max-tokens", "completed"]);
  assert.deepEqual(run.requests[3], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), "user: [U2]\nmore", memory("1.1", "m"),
  ]);
});

test("bad Spine input and a second Spine call are tool errors; the agent keeps working", async () => {
  const run = await scenario([
    [["spine_open", {}]],
    [["spine_open", { goal: "A" }], ["spine_open", { goal: "B" }]],
    "ok",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const results = run.events.filter((event) => event.type === "tool/result").map((event) => event.data.message);
  assert.deepEqual(results.map((message) => message.isError === true), [true, false, true]);
  assert.match(results[0].content[0].text, /missing field `goal`/);
  assert.match(results[2].content[0].text, /only one Spine tool call is allowed per model response/);
  assert.equal(run.requests[2].at(-1), node("1.1", "A"));
});

test("Close with no open node is a tool error; the agent keeps working", async () => {
  const run = await scenario([
    [["spine_close", { memory: "m" }]],
    [["spine_open", { goal: "A" }]],
    "ok",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const results = run.events.filter((event) => event.type === "tool/result").map((event) => event.data.message);
  assert.deepEqual(results.map((message) => message.isError === true), [true, false]);
  assert.match(results[0].content[0].text, /no open Spine node is available to close/);
  assert.equal(run.requests[2].at(-1), node("1.1", "A"));
});

test("disposing an agent mid-request settles its sampling without error", async () => {
  const dsh = await mountDsh([{ hang: true }]);
  const agent = await dsh.ctx.agents.create({
    sessionId: "dispose-mid-request",
    meta: { cwd: process.cwd() },
    agentOptions: { provider: "scripted", model: "scripted" },
  });
  try {
    agent.agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
    while (dsh.adapter.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await agent.dispose();
    const ends = dsh.events(agent.agent).filter((event) => event.type === "turn/end");
    assert.equal(ends.at(-1)?.data.reason.kind, "aborted");
  } finally {
    await dsh.dispose();
  }
});
