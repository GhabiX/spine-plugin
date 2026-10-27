import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSpawnTasks,
  buildCompactBarrier,
  operationFromPiToolCall,
  PiSamplingLifecycle,
  PiSamplingLifecycleError,
  PiSpineToolMixError,
  PiSourceBindings,
} from "../dist/pi/index.js";

const SOURCE = {
  schema: "spine.source.snapshot.v1",
  thread: "session",
  epoch: 0,
  cells: [],
};

test("durable source reconciliation rejects a discontinuous tail", async () => {
  const { lifecycle } = harness();
  await assert.rejects(lifecycle.observePersistedSources([{ boundary: 1,
    message: { role: "user", content: "gap", timestamp: 1 } }]), /discontinuous/);
});

function harness(lifecycleOptions = {}) {
  const log = [];
  const adapter = {
    fault: null,
    async observeSources(characters) {
      log.push(["observe", characters]);
      return characters.map((character) => ({
        thread: "session",
        epoch: 0,
        ordinal: character.boundary,
      }));
    },
    async previewAndPublish() { log.push(["preview"]); },
    async beginSampling(digest) { log.push(["begin", digest]); },
    async registerExecution(key) { log.push(["register", key]); },
    async stageExecution(key, executionRef, operation) {
      log.push(["stage", key, executionRef, operation]);
    },
    async finishExecution(key, succeeded) { log.push(["finish-execution", key, succeeded]); },
    async finishSampling(terminal, inputTokens) {
      log.push(["finish-sampling", terminal, inputTokens]);
      return { type: "orphaned" };
    },
  };
  const bindings = new PiSourceBindings();
  return { log, bindings, lifecycle: new PiSamplingLifecycle(adapter, bindings, SOURCE, lifecycleOptions) };
}

test("Pi lifecycle admits source, persists sampling start, and commits one turn", async () => {
  const { log, bindings, lifecycle } = harness();
  const user = { role: "user", content: "request", timestamp: 1 };
  await lifecycle.observeMessage(user);
  await lifecycle.previewContext();
  await lifecycle.beginSampling();
  await lifecycle.finishTurn({
    aborted: false,
    message: {
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: { input: 17, cacheRead: 3, cacheWrite: 4 },
      timestamp: 2,
    },
  });

  assert.deepEqual(bindings.resolve({ thread: "session", epoch: 0, ordinal: 0 }), user);
  assert.deepEqual(log.map(([kind]) => kind), ["observe", "preview", "begin", "finish-sampling"]);
  assert.deepEqual(log.at(-1), ["finish-sampling", "completed", 24]);
});

test("Pi lifecycle skips a clean preview and republishes after a source mutation", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.observeMessage({ role: "user", content: "first", timestamp: 1 });
  await lifecycle.previewContext();
  await lifecycle.previewContext();
  assert.equal(log.filter(([kind]) => kind === "preview").length, 1);

  await lifecycle.observeMessage({ role: "user", content: "second", timestamp: 2 });
  await lifecycle.previewContext();
  assert.equal(log.filter(([kind]) => kind === "preview").length, 2);

  await lifecycle.beginSampling();
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
  });
  await lifecycle.previewContext();
  assert.equal(log.filter(([kind]) => kind === "preview").length, 2);
});

test("Pi lifecycle trusts the projection published during recovery", async () => {
  const { log, lifecycle } = harness({ contextReady: true });
  await lifecycle.previewContext();
  assert.equal(log.some(([kind]) => kind === "preview"), false);
});

test("Pi lifecycle decodes tree input before recording execution admission", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.beginSampling();
  await assert.rejects(
    lifecycle.registerToolCall("invalid", "spine_open", { goal: "x".repeat(4097) }),
    PiSamplingLifecycleError,
  );
  assert.equal(log.some(([kind]) => kind === "register"), false);
  assert.equal(log.some(([kind]) => kind === "stage"), false);
  assert.equal(lifecycle.fault, null);
});

test("Pi lifecycle rejects invalid Spawn input before recording execution admission", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.beginSampling();
  await assert.rejects(
    lifecycle.registerToolCall("invalid-spawn", "spine_spawn", {
      tasks: Array.from({ length: 17 }, (_, index) => ({ summary: `s${index}`, prompt: `p${index}` })),
    }),
    PiSamplingLifecycleError,
  );
  assert.equal(log.some(([kind]) => kind === "register"), false);
  assert.equal(log.some(([kind]) => kind === "stage"), false);
  assert.equal(lifecycle.fault, null);
});

test("Pi compact barrier rejects unsafe source and replacement boundaries", () => {
  assert.throws(
    () => buildCompactBarrier({
      ...SOURCE,
      cells: [{ boundary: Number.MAX_SAFE_INTEGER, source_id: { thread: "session", epoch: 0, ordinal: 0 }, item: {} }],
    }, 1),
    /source boundary is exhausted/,
  );
  assert.throws(
    () => buildCompactBarrier({
      ...SOURCE,
      cells: [{ boundary: Number.MAX_SAFE_INTEGER - 1, source_id: { thread: "session", epoch: 0, ordinal: 0 }, item: {} }],
    }, 2),
    /replacement boundary is exhausted/,
  );
});

test("Pi lifecycle maps validated transition tools and finishes typed executions", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.beginSampling();
  assert.equal(await lifecycle.registerToolCall("call-1", "read", {}), false);
  assert.equal(
    await lifecycle.registerToolCall("call-2", "spine_next", {
      goal: "next scope",
      memory: "closed memory",
    }),
    true,
  );
  assert.equal(await lifecycle.finishToolCall("other", true), false);
  assert.equal(await lifecycle.finishToolCall("call-2", true), true);
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "toolUse", timestamp: 2 },
  });

  assert.deepEqual(log.find(([kind]) => kind === "stage"), [
    "stage",
    "call-2",
    "call-2",
    { type: "next", closed_memory: "closed memory", next_summary: "next scope" },
  ]);
});

test("Pi lifecycle stages Spawn with its tasks at tool_call and abort wins terminal mapping", async () => {
  const { log, lifecycle } = harness();
  const tasks = [
    { summary: "child-a", prompt: "do child work a" },
    { summary: "child-b", prompt: "do child work b" },
  ];
  await lifecycle.beginSampling();
  await lifecycle.registerToolCall("spawn-1", "spine_spawn", { tasks });
  const staged = log.find(([kind]) => kind === "stage");
  assert.deepEqual(staged.slice(1), ["spawn-1", "spawn-1", { type: "spawn", tasks }]);
  await lifecycle.finishToolCall("spawn-1", true);
  await lifecycle.finishTurn({
    aborted: true,
    message: { role: "assistant", content: [], stopReason: "stop", timestamp: 2 },
  });
  assert.deepEqual(log.at(-1), ["finish-sampling", "cancelled", undefined]);
});

test("Pi lifecycle treats idle and repeated finishTurn as identity", async () => {
  const { log, lifecycle } = harness();
  const cancelled = {
    aborted: true,
    message: { role: "assistant", content: [], stopReason: "error", timestamp: 2 },
  };
  assert.equal(await lifecycle.finishTurn(cancelled), null);
  assert.equal(lifecycle.fault, null);
  await lifecycle.beginSampling();
  await lifecycle.finishTurn(cancelled);
  assert.deepEqual(log.at(-1), ["finish-sampling", "cancelled", undefined]);
  assert.equal(await lifecycle.finishTurn(cancelled), null);
  assert.equal(
    await lifecycle.finishTurn({
      aborted: false,
      message: { role: "assistant", content: [], stopReason: "error", timestamp: 3 },
    }),
    null,
  );
  assert.equal(lifecycle.fault, null);
  assert.equal(log.filter(([kind]) => kind === "finish-sampling").length, 1);
  await lifecycle.beginSampling();
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "stop", timestamp: 4 },
  });
  assert.equal(log.filter(([kind]) => kind === "finish-sampling").length, 2);
  assert.deepEqual(log.at(-1), ["finish-sampling", "completed", undefined]);
});

test("Pi lifecycle blocks spawn mixed with tree tools without latching a fault", async () => {
  const { lifecycle } = harness();
  const tasks = [
    { summary: "a", prompt: "pa" },
    { summary: "b", prompt: "pb" },
  ];
  await lifecycle.beginSampling();
  assert.equal(await lifecycle.registerToolCall("open-1", "spine_open", { goal: "inspect" }), true);
  await assert.rejects(
    lifecycle.registerToolCall("spawn-1", "spine_spawn", { tasks }),
    (error) =>
      error instanceof PiSpineToolMixError &&
      /spine_spawn cannot be mixed with spine_open, spine_close, or spine_next/.test(error.message),
  );
  assert.equal(lifecycle.fault, null);
  assert.equal(await lifecycle.finishToolCall("open-1", true), true);
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "toolUse", timestamp: 2 },
  });
  assert.equal(lifecycle.fault, null);

  await lifecycle.beginSampling();
  assert.equal(await lifecycle.registerToolCall("spawn-2", "spine_spawn", { tasks }), true);
  await assert.rejects(
    lifecycle.registerToolCall("close-1", "spine_close", { memory: "done" }),
    PiSpineToolMixError,
  );
  assert.equal(lifecycle.fault, null);
  assert.equal(await lifecycle.finishToolCall("close-1", true), false);
  assert.equal(await lifecycle.finishToolCall("spawn-2", true), true);
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "toolUse", timestamp: 3 },
  });
  assert.equal(lifecycle.fault, null);
});

test("Pi lifecycle faults closed on an unfinished transition", async () => {
  const { lifecycle } = harness();
  await lifecycle.beginSampling();
  await lifecycle.registerToolCall("call", "spine_open", { goal: "scope" });
  await assert.rejects(
    lifecycle.finishTurn({
      aborted: false,
      message: { role: "assistant", content: [], stopReason: "stop", timestamp: 2 },
    }),
    PiSamplingLifecycleError,
  );
  await assert.rejects(lifecycle.previewContext(), PiSamplingLifecycleError);
});

test("Pi lifecycle drains unfinished executions on cancelled finishTurn", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.beginSampling();
  await lifecycle.registerToolCall("call", "spine_open", { goal: "scope" });
  await lifecycle.finishTurn({
    aborted: true,
    message: { role: "assistant", content: [], stopReason: "error", timestamp: 2 },
  });
  assert.equal(lifecycle.fault, null);
  assert.deepEqual(log.at(-2), ["finish-execution", "call", false]);
  assert.deepEqual(log.at(-1), ["finish-sampling", "cancelled", undefined]);
  await lifecycle.beginSampling();
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
  });
  assert.equal(lifecycle.fault, null);
  assert.deepEqual(log.at(-1), ["finish-sampling", "completed", undefined]);
});

test("Pi lifecycle rejects deferred assistant responses instead of inventing completion", async () => {
  const { lifecycle } = harness();
  await lifecycle.beginSampling();
  await assert.rejects(
    lifecycle.finishTurn({
      aborted: false,
      message: { role: "assistant", content: [], stopReason: "deferred", timestamp: 2 },
    }),
    (error) =>
      error instanceof PiSamplingLifecycleError &&
      /deferred assistant responses are unsupported/.test(String(error.cause)),
  );
  await assert.rejects(lifecycle.previewContext(), PiSamplingLifecycleError);
});

test("Pi tool and provider payload decoders are exact", () => {
  assert.deepEqual(operationFromPiToolCall("spine_close", { memory: "memory" }), {
    type: "close",
    memory: "memory",
  });
  assert.deepEqual(
    decodeSpawnTasks({
      tasks: [
        { summary: "s", prompt: "p" },
        { summary: "t", prompt: "q" },
      ],
    }),
    [
      { summary: "s", prompt: "p" },
      { summary: "t", prompt: "q" },
    ],
  );
  assert.throws(() => decodeSpawnTasks({ tasks: [{ summary: "", prompt: "p" }] }),
    PiSamplingLifecycleError);
  assert.throws(
    () => decodeSpawnTasks({
      tasks: Array.from({ length: 17 }, (_, index) => ({ summary: `s${index}`, prompt: `p${index}` })),
    }),
    (error) =>
      error instanceof PiSamplingLifecycleError &&
      /invalid Pi Spine Spawn input/.test(error.message) &&
      /at most 16 tasks/.test(String(error.cause)),
  );
});
