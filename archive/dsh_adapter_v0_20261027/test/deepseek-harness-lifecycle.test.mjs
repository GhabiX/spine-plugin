import assert from "node:assert/strict";
import test from "node:test";

import {
  DeepSeekHarnessSamplingLifecycle,
} from "../dist/deepseek-harness/lifecycle.js";
import { DeepSeekHarnessSourceBindings } from "../dist/deepseek-harness/messages.js";
import { apply, name } from "../dist/deepseek-harness/extension.js";

const EMPTY_SOURCE = {
  schema: "spine.source.snapshot.v1",
  thread: "dsh-1",
  epoch: 0,
  cells: [],
};

function message(id, source = { kind: "user" }) {
  return { id, role: "user", content: [{ type: "text", text: id }], source };
}

function adapter(log) {
  let ordinal = 0;
  return {
    fault: null,
    async observeSources(characters) {
      log.push(["observe", characters]);
      return characters.map(() => ({ thread: "dsh-1", epoch: 0, ordinal: ordinal++ }));
    },
    async beginSampling(digest) { log.push(["begin", digest]); },
    async registerExecution(key) { log.push(["register", key]); },
    async stageExecution(key, ref, operation) { log.push(["stage", key, ref, operation]); },
    async finishExecution(key, succeeded) { log.push(["finish-execution", key, succeeded]); },
    async finishSampling(terminal, inputTokens) { log.push(["finish", terminal, inputTokens]); },
    dispose() { log.push(["dispose"]); },
  };
}

test("DSH lifecycle serializes typed source, execution, and PostSampling boundaries", async () => {
  const log = [];
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter(log),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  lifecycle.enqueueMessage(message("user-1"));
  await lifecycle.beginSampling({ provider: "test", signal: new AbortController().signal });
  assert.equal(lifecycle.enqueueToolStart({
    callId: "call-1",
    name: "spine_open",
    arguments: JSON.stringify({ goal: "child" }),
  }), true);
  lifecycle.enqueueToolFinish("call-1", true);
  lifecycle.enqueueMessage(message("tool-1", { kind: "tool", callId: "call-1" }), 17);
  lifecycle.enqueueSuccessfulStepEnd();
  await lifecycle.finishPendingSuccess();

  assert.deepEqual(log.map(([kind]) => kind), [
    "observe",
    "begin",
    "register",
    "stage",
    "finish-execution",
    "observe",
    "finish",
  ]);
  assert.deepEqual(log[3][3], { type: "open", summary: "child" });
  assert.deepEqual(log.at(-1), ["finish", "completed", 17]);
});

test("DSH lifecycle permanently faults on ownership violation", async () => {
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter([]),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  lifecycle.violate(new Error("native compaction"));
  await assert.rejects(lifecycle.drain(), /lifecycle fault/);
  await assert.rejects(lifecycle.beginSampling({}), /lifecycle fault/);
});

test("DSH successful step marker defers commit and an exceptional boundary overrides it", async () => {
  const log = [];
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter(log),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  await lifecycle.beginSampling({ provider: "test" });
  lifecycle.enqueueSuccessfulStepEnd();
  await lifecycle.finishNow("failed");
  assert.deepEqual(log.filter(([kind]) => kind === "finish"), [["finish", "failed", undefined]]);
});

test("loadable DSH extension registers exactly the four canonical tools", () => {
  const tools = [];
  const listeners = [];
  const ctx = {
    sessions: {},
    subagents: {},
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    get() { return undefined; },
    on(event, listener) { listeners.push([event, listener]); return () => {}; },
    effect() {},
  };
  apply(ctx, {});
  assert.equal(name, "spine");
  assert.deepEqual(tools.map((tool) => tool.name), [
    "spine_open",
    "spine_close",
    "spine_next",
    "spine_spawn",
  ]);
  assert.ok(listeners.some(([event]) => event === "llm/stream"));
  assert.ok(listeners.some(([event]) => event === "agent/pre-step"));
});

test("DSH extension preserves identity when disabled and rejects native compaction owner", () => {
  let touched = false;
  const disabled = {
    get sessions() { touched = true; throw new Error("touched"); },
  };
  apply(disabled, { enabled: false });
  assert.equal(touched, false);

  assert.throws(() => apply({ get: () => ({}), sessions: {}, tools: {}, subagents: {} }, {}),
    /exclusive compaction ownership/);
});
