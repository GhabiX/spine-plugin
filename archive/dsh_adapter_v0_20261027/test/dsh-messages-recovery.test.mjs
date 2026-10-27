import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeepSeekHarnessReplayPlan,
  DeepSeekHarnessRecoveryError,
  DeepSeekHarnessSourceBindings,
  installDeepSeekHarnessSourceBindings,
  materializeDeepSeekHarnessContext,
  observeDeepSeekHarnessMessage,
  recoverDeepSeekHarnessSession,
} from "../dist/deepseek-harness/index.js";

const user = {
  id: "user-1",
  role: "user",
  content: [{ type: "text", text: "hello" }],
  source: { kind: "user" },
};
const tool = {
  id: "tool-1",
  role: "user",
  content: [{ type: "tool-result", toolCallId: "call-1", content: [] }],
  source: { kind: "tool", callId: "call-1" },
};

test("DSH message transport preserves native messages and canonical projections", () => {
  assert.equal(observeDeepSeekHarnessMessage(tool, 1).character.type, "opaque");
  const bindings = new DeepSeekHarnessSourceBindings();
  bindings.bind({ thread: "s", epoch: 0, ordinal: 0 }, user);
  const messages = materializeDeepSeekHarnessContext({
    transactionId: "tx",
    projection: { nodes: [], cursor: [], visible_context: [], last_boundary: 1 },
    contextPlan: {
      schema: "spine.context.plan.v2",
      thread: "s",
      epoch: 0,
      source_snapshot_digest: "source",
      plan_digest: "plan",
      cells: [
        {
          type: "source",
          source_id: { thread: "s", epoch: 0, ordinal: 0 },
          labels: [{ UserAnchor: 3 }],
        },
        {
          type: "projection",
          projection_id: { thread: "s", epoch: 0, ordinal: 1 },
          item: {
            MemorySlot: {
              Summary: { owner_node: [1], source: { start: 0, end: 1 }, body: "memory" },
            },
          },
        },
      ],
    },
  }, bindings);
  assert.equal(messages[0].content[0].text, "[U3]\nhello");
  assert.match(messages[1].content[0].text, /<spine_memory node_id="1">/);
  assert.equal(user.content[0].text, "hello");
});

test("DSH replay plan preserves physical source/archive order and ignores derived projection", () => {
  const archive = startedArchive("old");
  const plan = buildDeepSeekHarnessReplayPlan("fork", [
    { type: "user/message", data: user },
    { type: "spine/archive", data: archive },
    { type: "surface/projection", data: {} },
    { type: "tool/result", data: { message: tool } },
  ]);
  assert.equal(plan.runtimeThread, "old");
  assert.deepEqual(plan.inputs.map((item) => item.type), ["source", "archive", "source"]);
  assert.equal(plan.sources.length, 2);
});

test("DSH replay rejects native compaction ownership violations", () => {
  assert.throws(
    () => buildDeepSeekHarnessReplayPlan("s", [{ type: "compaction/compact", data: {} }]),
    DeepSeekHarnessRecoveryError,
  );
});

test("DSH recovery binds exact replay cells before publication and continues fork namespace", async () => {
  const log = [];
  const plan = buildDeepSeekHarnessReplayPlan("fork", [
    { type: "user/message", data: user },
    { type: "spine/archive", data: startedArchive("old") },
  ]);
  const source = {
    schema: "spine.source.snapshot.v1",
    thread: "old",
    epoch: 0,
    cells: [{
      source_id: { thread: "old", epoch: 0, ordinal: 0 },
      boundary: 0,
      item: { Message: { message: { boundary: 0, role: "User", content: "{}" }, user_anchor: null } },
    }],
  };
  const adapter = {
    async replayWithSources(_inputs, install) {
      log.push("replay");
      await install(source);
      log.push("publish");
    },
    async continueNamespace(thread) {
      log.push(`continue:${thread}`);
      return {
        ...source,
        thread,
        cells: source.cells.map((cell) => ({
          ...cell,
          source_id: { ...cell.source_id, thread },
        })),
      };
    },
    async previewAndPublish() { log.push("fork-publish"); },
  };
  const recovered = await recoverDeepSeekHarnessSession({
    plan,
    runtimeFactory: () => ({}),
    adapterFactory: async () => adapter,
  });
  assert.deepEqual(log, ["replay", "publish", "continue:fork", "fork-publish"]);
  assert.equal(recovered.bindings.resolve({ thread: "fork", epoch: 0, ordinal: 0 }).id, "user-1");
});

test("DSH source installation fails closed on boundary mismatch", () => {
  assert.throws(() => installDeepSeekHarnessSourceBindings(
    new DeepSeekHarnessSourceBindings(),
    {
      schema: "spine.source.snapshot.v1",
      thread: "s",
      epoch: 0,
      cells: [{
        source_id: { thread: "s", epoch: 0, ordinal: 0 },
        boundary: 9,
        item: { Message: { message: { boundary: 9, role: "User", content: "{}" }, user_anchor: null } },
      }],
    },
    [{ boundary: 0, message: user }],
  ), DeepSeekHarnessRecoveryError);
});

test("DSH recovery disposes the adapter when replay fails", async () => {
  const failure = new Error("replay failed");
  let disposals = 0;
  await assert.rejects(
    recoverDeepSeekHarnessSession({
      plan: buildDeepSeekHarnessReplayPlan("session", []),
      runtimeFactory: () => ({}),
      adapterFactory: async () => ({
        async replayWithSources() { throw failure; },
        dispose() { disposals += 1; },
      }),
    }),
    failure,
  );
  assert.equal(disposals, 1);
});

function startedArchive(thread) {
  return {
    schema: "spine-plugin/deepseek-harness/v1",
    durabilityId: "started",
    record: {
      type: "sampling_started",
      record: {
        schema: "spine.sampling.started",
        attempt_id: { thread, value: "attempt" },
        epoch: 0,
        pre_boundary: { thread, epoch: 0, ordinal: 1 },
        previous_commit_id: null,
        prompt_digest: "prompt",
        source_digest: "source",
        record_digest: "started",
      },
    },
  };
}
