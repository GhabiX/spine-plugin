import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { compactionFixture, responsesFixtureFetch } from "./pi-compaction-fixture.mjs";

const ai = await import(process.env.SPINE_TEST_HOST
  ? pathToFileURL(`${process.env.SPINE_TEST_HOST}/node_modules/@earendil-works/pi-ai/dist/compat.js`).href
  : "@earendil-works/pi-ai/compat");

for (const reserveTokens of [16384, 52429, 0]) {
  test(`Pi compaction budget: Responses adapter with o3 and reserve=${reserveTokens} preserves answer room`, async t => {
    const model = ai.getModel("openai", "o3");
    assert.equal(model.maxTokens, 100000);
    assert.equal(model.contextWindow, 200000);
    assert.equal(model.thinkingLevelMap.off, null); // This model cannot disable reasoning.
    const requests = [], responses = [], optionsSeen = [];
    const f = await compactionFixture(t, { model, reserveTokens, async complete(m, context, options) {
      optionsSeen.push(options);
      const response = await ai.streamOpenAIResponses(m, context, {
        ...options, apiKey: "sk-offline-fixture", maxRetries: 0,
        fetch: responsesFixtureFetch(requests),
      }).result();
      responses.push(response);
      return response;
    } });
    const result = await f.compact();
    assert.equal(optionsSeen[0].maxTokens, model.maxTokens);
    assert.equal(requests[0].max_output_tokens, model.maxTokens);
    assert.equal(requests[0].reasoning, undefined); // No invented thinking-level override.
    assert.equal(result.compaction?.summary, "## Goal\nContinue the task.");
    assert.equal(result.compaction.usage.reasoning, 14000);
    assert.equal(result.compaction.usage.output, 14064);
    assert.equal(responses[0].stopReason, "stop");
    assert.equal(f.notifications.length, 0);
    assert.equal(f.aborts, 0);
    assert.equal(f.entries.filter(e => e.customType === "spine.compact.v1").length, 1);
    await f.emit("session_compact");
  });
}

for (const maxTokens of [100, 4096, 32768]) {
  test(`Pi compaction budget: ordinary non-reasoning model uses maxTokens=${maxTokens}`, async t => {
    const model = { provider: "test", id: "ordinary", reasoning: false, maxTokens };
    let seen;
    const f = await compactionFixture(t, { model, reserveTokens: 16384, async complete(_m, _c, options) {
      seen = options;
      return { content: [{ type: "text", text: "normal summary" }], stopReason: "stop" };
    } });
    const signal = new AbortController().signal;
    assert.equal((await f.compact(signal)).compaction.summary, "normal summary");
    assert.equal(seen.maxTokens, maxTokens);
    assert.equal(seen.signal, signal);
    assert.equal(seen.cacheRetention, "none");
    assert.equal(typeof seen.sessionId, "string");
    await f.emit("session_compact");
  });
}

async function assertSoftCancel(f, result, notification) {
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(f.notifications, notification ? [[notification, "error"]] : []);
  assert.equal(f.aborts, 0);
  assert.equal(f.entries.some(e => ["spine.compact.v1", "spine.fault.v1"].includes(e.customType)), false);
  const context = await f.emit("context", { type: "context", messages: [] });
  assert.ok(Array.isArray(context.messages)); // No durability fault latched; sampling can resume.
}

test("Pi compaction budget: full model budget still rejects a reasoning-only protocol response", async t => {
  const model = ai.getModel("openai", "o3"), requests = [];
  let response;
  const f = await compactionFixture(t, { model, async complete(m, context, options) {
    response = await ai.streamOpenAIResponses(m, context, {
      ...options, apiKey: "sk-offline-fixture", maxRetries: 0,
      fetch: responsesFixtureFetch(requests, { alwaysNoText: true }),
    }).result();
    return response;
  } });
  await assertSoftCancel(f, await f.compact(), "Pi compaction model returned an empty summary");
  assert.equal(requests[0].max_output_tokens, 100000);
  assert.equal(response.stopReason, "length");
  assert.equal(response.usage.reasoning, 100000);
  assert.deepEqual(response.content.map(c => c.type), ["thinking"]);
});

for (const [label, response, notification] of [
  ["aborted", { content: [{ type: "text", text: "partial" }], stopReason: "aborted" }, undefined],
  ["error", { content: [{ type: "text", text: "not a summary" }], stopReason: "error", errorMessage: "provider overloaded" }, "provider overloaded"],
  ["error fallback", { content: [], stopReason: "error", errorMessage: "  " }, "Pi compaction model returned stopReason=error"],
  ["blank text", { content: [{ type: "text", text: "   " }], stopReason: "stop" }, "Pi compaction model returned an empty summary"],
]) {
  test(`Pi compaction budget: ${label} keeps the soft-cancel semantics`, async t => {
    const f = await compactionFixture(t, { model: { provider: "test", id: "ordinary", maxTokens: 4096 },
      async complete() { return response; } });
    await assertSoftCancel(f, await f.compact(), notification);
  });
}

test("Pi compaction budget: host abort discards even a completed text answer", async t => {
  const controller = new AbortController();
  const f = await compactionFixture(t, { model: { provider: "test", id: "ordinary", maxTokens: 4096 },
    async complete() { controller.abort(); return { content: [{ type: "text", text: "discard" }], stopReason: "stop" }; } });
  await assertSoftCancel(f, await f.compact(controller.signal));
});
