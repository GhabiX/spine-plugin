// Spine on the production DSH AgentLoop with a scripted model. The plugin
// itself refuses any model request that differs from its Spine plan, so a
// turn that completes also proves every request in it showed the plan.
import assert from "node:assert/strict";
import test from "node:test";

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { mountDsh } from "./harness.mjs";
import { call, memory, shown, result, closed } from "./shown.mjs";

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

test("Open shows the node; Close shows it with its call, then the next sampling folds it to its memory", async () => {
  const run = await scenario(
    [[["spine_open", { goal: "inspect" }]], [["spine_close", { memory: "found it" }]], "done", "ok"],
    async (dsh) => {
      const agent = await dsh.run("start");
      await dsh.send(agent, "more");
      return agent;
    },
  );
  assert.deepEqual(run.ends, ["completed", "completed"]);
  assert.deepEqual(run.requests, [
    ["user: [U1]\nstart", "context: …"],
    ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "inspect" }), result("spine_open", "1.1", "inspect")],
    ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "inspect" }), result("spine_open", "1.1", "inspect"),
      call("spine_close", { memory: "found it" }), result("spine_close")],
    ["user: [U1]\nstart", "context: …", closed("1.1", "inspect"), memory("1.1", "found it"), "assistant: done", "user: [U2]\nmore"],
  ]);
  assert.equal(run.samplings, 4);
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
    "ok",
  ], async (dsh) => {
    const agent = await dsh.run("start");
    await dsh.send(agent, "more");
    await dsh.send(agent, "last");
    return agent;
  });
  assert.deepEqual(run.ends, ["completed", "completed", "completed"]);
  const next = [call("spine_next", { memory: "memA", goal: "B" }), result("spine_next", "1.1", "1.2", "B")];
  // Next shows A as it was; reply1, the next sampling, folds it.
  assert.deepEqual(run.requests[2], [...run.requests[1], ...next]);
  assert.deepEqual(run.requests[3], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), ...next, "assistant: reply1",
    "user: [U2]\nmore",
  ]);
  assert.deepEqual(run.requests[4], [...run.requests[3], call("spine_open", { goal: "C" }), result("spine_open", "1.2.1", "C")]);
  assert.deepEqual(run.requests[5], [...run.requests[4], call("spine_close", { memory: "memC" }), result("spine_close", "1.2.1")]);
  // Closing B right after C folds C and shows B as it was; reply2 folds B.
  const closeB = [call("spine_close", { memory: "memB" }), result("spine_close", "1.2")];
  assert.deepEqual(run.requests[6], [
    ...run.requests[3], closed("1.2.1", "C"), memory("1.2.1", "memC"), ...closeB,
  ]);
  assert.deepEqual(run.requests[7], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), closed("1.2", "B"), "assistant: reply1", "user: [U2]\nmore", memory("1.2.1", "memC"),
    memory("1.2", "memB"), "assistant: reply2", "user: [U3]\nlast",
  ]);
});

test("a Next sampling keeps its reasoning until the closed node folds; the folding sampling shows without it", async () => {
  const run = await scenario([
    { reasoning: "why open", calls: [["spine_open", { goal: "A" }]] },
    { reasoning: "why next", calls: [["spine_next", { memory: "memA", goal: "B" }], ["probe", {}]] },
    { reasoning: "why probe", calls: [["probe", {}]] },
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const open = `assistant: <reasoning>${call("spine_open", { goal: "A" }).slice("assistant: ".length)}`;
  assert.deepEqual(run.requests[1], ["user: [U1]\nstart", "context: …", open, result("spine_open", "1.1", "A")]);
  // Next shows A as it was, so the Next sampling, which belongs to node 1.2,
  // keeps its reasoning; its other result stays.
  const results = [result("spine_next", "1.1", "1.2", "B"), "tool: Error: unknown tool \"probe\""];
  const nextCall = "spine_next {\"memory\":\"memA\",\"goal\":\"B\"}probe {}";
  assert.deepEqual(run.requests[2], [...run.requests[1], `assistant: <reasoning>${nextCall}`, ...results]);
  // The next sampling folds A: it and the Next sampling show without their reasoning.
  assert.deepEqual(run.requests[3], ["user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), `assistant: ${nextCall}`, ...results,
    call("probe", {}), "tool: Error: unknown tool \"probe\""]);
  // One decision, at the fold, names both.
  const drops = run.events.filter((event) => event.type === "plugin:spinejit/without-reasoning");
  assert.deepEqual(drops.map((event) => event.data.seqs.length), [2]);
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
    [["probe", {}]],
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  assert.equal(run.requests[2].at(-1), "context: …", "DSH added runtime context inside node A");
  assert.deepEqual(run.requests[3], [...run.requests[2], call("spine_close", { memory: "memA" }), result("spine_close")]);
  assert.deepEqual(run.requests[4], [
    "user: [U1]\nstart", "context: …", "context: …", closed("1.1", "A"),
    memory("1.1", "memA"), call("probe", {}), "tool: probed",
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
    [["probe", {}]],
    "done",
  ], (dsh) => dsh.run("start"));
  assert.deepEqual(run.ends, ["completed"]);
  const results = run.events.filter((event) => event.type === "tool/result").map((event) => event.data.message);
  assert.deepEqual(results.map((message) => message.isError === true), [false, true, false, false, false]);
  assert.match(results[1].content[0].text, /spine_close must be the only tool call in its response/);
  assert.deepEqual(run.requests[3], [...run.requests[2], call("spine_close", { memory: "memA" }), result("spine_close")]);
  assert.deepEqual(run.requests[4], ["user: [U1]\nstart", "context: …", closed("1.1", "A"), memory("1.1", "memA"), call("probe", {}), "tool: probed"]);
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
      "user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), result("spine_open", "1.1", "A"), "user: [U2]\nagain",
    ]);
    assert.equal(run.samplings, 3);
  }
});

test("text cut off at max tokens is no reply: Close folds it into the node", async () => {
  const run = await scenario(
    [[["spine_open", { goal: "A" }]], { text: "partial", finish: "max-tokens" }, [["spine_close", { memory: "m" }]], "done", "ok"],
    async (dsh) => {
      const agent = await dsh.run("start");
      await dsh.send(agent, "more");
      await dsh.send(agent, "last");
      return agent;
    },
  );
  assert.deepEqual(run.ends, ["max-tokens", "completed", "completed"]);
  assert.deepEqual(run.requests[3], [...run.requests[2], call("spine_close", { memory: "m" }), result("spine_close")]);
  assert.deepEqual(run.requests[4], [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), "user: [U2]\nmore", memory("1.1", "m"), "assistant: done", "user: [U3]\nlast",
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
  // The admitted call's result carries the node it opened; the refused one's follows it.
  assert.equal(run.requests[2].at(-2), result("spine_open", "1.1", "A"));
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
  assert.match(results[0].content[0].text, /You are at the root: no Spine node is open, so there is none to close/);
  assert.equal(run.requests[2].at(-1), result("spine_open", "1.1", "A"));
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
