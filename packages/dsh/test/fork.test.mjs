import assert from "node:assert/strict";
import test from "node:test";
import { buildForkSeed, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";

import { mountDsh } from "./harness.mjs";
import { memory, shown } from "./shown.mjs";

/** The same seed and metadata DSH's ordinary Fork command hands to its Agent registry. */
async function fork(dsh, source, id, boundary = source.session.seq - 1) {
  const { agent } = await dsh.ctx.agents.create({
    sessionId: SessionId(id),
    seed: buildForkSeed(source.session.snapshotEvents(), boundary),
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: { cwd: dsh.root, isSeeded: true },
    agentOptions: { provider: "scripted", model: "scripted" },
  });
  assert.equal(agent.session.header.parentSession, undefined);
  return agent;
}

function ends(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind);
}

function userAnchors(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === "plugin:spinejit/user-anchors")
    .flatMap((event) => event.data.anchors.map(({ anchor }) => anchor));
}

const open = (goal) => [["spine_open", { goal }]];
const close = (text) => [["spine_close", { memory: text }]];

test("an ordinary Fork continues the copied Spine history and survives restart", async () => {
  const first = await mountDsh([open("Original task"), "original reply", close("fork memory"), "fork reply"]);
  try {
    const source = await first.run("original input");
    const before = structuredClone(source.session.snapshotEvents());
    const branch = await fork(first, source, "fork-1");
    await first.send(branch, "fork input");
    assert.deepEqual(ends(branch), ["completed", "completed"]);
    assert.deepEqual(userAnchors(branch), [1, 2]);
    assert.match(shown(first.adapter.requests[2]).join("\n"), /user: \[U1\]\noriginal input[^]*original reply[^]*fork input/);
    assert.deepEqual(source.session.snapshotEvents(), before, "continuing the fork does not change its source log");
  } finally {
    await first.dispose();
  }

  const second = await mountDsh(["resumed reply"], { root: first.root });
  try {
    const branch = await second.resume("fork-1");
    await second.send(branch, "input after restart");
    assert.deepEqual(ends(branch), ["completed", "completed", "completed"]);
    assert.deepEqual(userAnchors(branch), [1, 2, 3]);
    assert.ok(shown(second.adapter.requests[0]).includes(memory("1.1", "fork memory")));
    assert.deepEqual(await second.restored(branch), branch.session.deriveMessages());
  } finally {
    await second.dispose();
  }
});

test("a Fork before a tool result carries the synthetic result into its first request and survives restart", async () => {
  const first = await mountDsh({
    "session-1": [open("Original task"), "original reply"],
    "fork-after-assistant": ["fork reply"],
    "fork-after-call": ["fork reply"],
  });
  const expectedResults = new Map();
  try {
    const source = await first.run("original input");
    const events = structuredClone(source.session.snapshotEvents());
    const assistant = events.find((event) => event.type === "assistant/message");
    const call = events.find((event) => event.type === "tool/call");
    assert.ok(assistant && call);
    const cuts = [["fork-after-assistant", assistant.seq], ["fork-after-call", call.seq]];
    for (const [id, cut] of cuts) {
      const branch = await fork(first, source, id, cut);
      const result = branch.session.snapshotEvents().find((event) => event.type === "tool/result");
      assert.ok(result && result.seq > cut, "DSH completes the interrupted call in the fork seed");
      assert.equal(result.data.message.toolCallId, call.data.callId);
      assert.equal(result.data.message.isError, true);
      expectedResults.set(id, result.data.message);

      await first.send(branch, "first fork input");
      const requests = first.adapter.requests.filter((request) => request.sessionId === id);
      assert.equal(requests.length, 1, `${id} makes its first model request`);
      const messages = requests[0].messages;
      const assistantIndex = messages.findIndex((message) => message.role === "assistant" &&
        message.content.some((block) => block.type === "tool-call" && block.id === call.data.callId));
      assert.ok(assistantIndex >= 0);
      assert.deepEqual(messages[assistantIndex + 1], result.data.message);
      assert.deepEqual(ends(branch), ["forked", "completed"]);
      assert.deepEqual(userAnchors(branch), [1, 2]);
    }
    assert.deepEqual(source.session.snapshotEvents(), events, "forking does not change the original log");
  } finally {
    await first.dispose();
  }

  const second = await mountDsh(["resumed reply", "resumed reply"], { root: first.root });
  try {
    for (const [id, expectedResult] of expectedResults) {
      const branch = await second.resume(id);
      await second.send(branch, "input after restart");
      const requests = second.adapter.requests.filter((request) => request.sessionId === id);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].messages.filter((message) => message.role === "tool"), [expectedResult]);
      assert.deepEqual(ends(branch), ["forked", "completed", "completed"]);
      assert.deepEqual(userAnchors(branch), [1, 2, 3]);
      assert.deepEqual(await second.restored(branch), branch.session.deriveMessages());
    }
  } finally {
    await second.dispose();
  }
});

test("a historical Fork and its next Fork retain the copied history without adopting pending Spawn tasks", async () => {
  const spawn = [["spine_spawn", { tasks: [{ summary: "X", prompt: "find x" }, { summary: "Y", prompt: "find y" }] }]];
  const first = await mountDsh({
    "session-1": [open("Parent task"), spawn, "waiting"],
    "session-1:spawn:1.1.1": [{ hang: true }],
    "session-1:spawn:1.1.2": [{ hang: true }],
    "fork-1": ["first fork reply"],
    "fork-2": [close("independent conclusion"), "second fork reply"],
  });
  try {
    const source = await first.run("start");
    const branch = await fork(first, source, "fork-1");
    assert.equal(branch.inbox.nextStep.length, 0, "the fork did not recover the original's pending children");
    await first.send(branch, "first fork input");
    const second = await fork(first, branch, "fork-2");
    assert.equal(second.inbox.nextStep.length, 0);
    await first.send(second, "second fork input");
    assert.deepEqual(ends(second), ["completed", "completed", "completed"]);
    assert.deepEqual(userAnchors(second), [1, 2, 3]);
    const calls = first.events(second).filter((event) => event.type === "tool/result");
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].data.message.isError, true, "copied pending children do not prevent closing the local task");
    assert.equal(first.adapter.requests.filter((request) => request.sessionId.includes(":spawn:")).length, 2);
  } finally {
    await first.dispose();
  }
});
