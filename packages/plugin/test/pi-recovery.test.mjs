import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { archiveRecordId } from "../dist/index.js";
import {
  buildPiReplayPlan,
  buildCompactBarrier,
  createPiSpineAdapter,
  installSourceBindings,
  PI_ADAPTER_ID,
  PI_ARCHIVE_ENTRY_TYPE,
  PI_COMPACT_ENTRY_TYPE,
  PiSessionRecoveryError,
  PiSourceBindings,
  recoverPiSession,
  materializePiContext,
} from "../dist/pi/index.js";

const PI_COMPACTION_FIXTURE = JSON.parse(
  await readFile(new URL("../../../fixtures/pi-session-compaction-entry.json", import.meta.url)),
);

const STARTED = {
  type: "sampling_started",
  record: {
    schema: "spine.sampling.started",
    attempt_id: { thread: "origin-session", value: "attempt-0" },
    epoch: 0,
    pre_boundary: { thread: "origin-session", epoch: 0, ordinal: 1 },
    previous_commit_id: null,
  },
};

const COMMIT = {
  type: "sampling_commit",
  record: {
    schema: "spine.sampling.commit",
    attempt_id: { thread: "origin-session", value: "attempt-0" },
    commit_id: { thread: "origin-session", value: "commit-0" },
    epoch: 0,
    previous_pre_boundary: null,
    pre_boundary: { thread: "origin-session", epoch: 0, ordinal: 1 },
    post_boundary: { thread: "origin-session", epoch: 0, ordinal: 2 },
    previous_commit_id: null,
    executions: [],
  },
};

function archive(record, durabilityId = archiveRecordId(record)) {
  return {
    type: "custom",
    customType: PI_ARCHIVE_ENTRY_TYPE,
    data: {
      schema: PI_ADAPTER_ID,
      durabilityId,
      record,
    },
  };
}

function source(thread, messages) {
  return {
    schema: "spine.source.snapshot.v1",
    thread,
    epoch: 0,
    cells: messages.map((message, ordinal) => ({
      source_id: { thread: "origin-session", epoch: 0, ordinal },
      boundary: ordinal,
      item: message.role === "toolResult"
        ? { Native: { source: { Rollout: { ordinal } } } }
        : { Message: { message: { boundary: ordinal, role: "User", content: "" }, user_anchor: null } },
    })),
  };
}

test("Pi replay preserves exact branch order for source and archive records", () => {
  const user = { role: "user", content: "request", timestamp: 1 };
  const assistant = { role: "assistant", content: [], timestamp: 2 };
  const branch = [
    { type: "message", messages: [user] },
    archive(STARTED),
    { type: "model_change", messages: [] },
    { type: "message", messages: [assistant] },
    archive(COMMIT),
  ];

  const plan = buildPiReplayPlan({
    currentSessionId: "fork-session",
    branch,
    messagesForEntry: (entry) => entry.messages ?? [],
  });

  assert.equal(plan.runtimeThread, "origin-session");
  assert.deepEqual(plan.inputs.map(({ type }) => type), [
    "source",
    "archive",
    "source",
    "archive",
  ]);
  assert.deepEqual(plan.sources.map(({ boundary }) => boundary), [0, 1]);
});

test("Pi replay rejects native compaction and malformed archive identity", () => {
  const build = (branch) => buildPiReplayPlan({
    currentSessionId: "session",
    branch,
    messagesForEntry: () => [],
  });

  assert.throws(() => build([{ type: "compaction" }]), PiSessionRecoveryError);
  const invalid = archive(STARTED);
  invalid.data.durabilityId = "different";
  assert.throws(() => build([invalid]), PiSessionRecoveryError);
});

test("Pi replay accepts live archive identity from attempt and commit ids without record_digest", () => {
  const plan = buildPiReplayPlan({
    currentSessionId: "origin-session",
    branch: [archive(STARTED), archive(COMMIT)],
    messagesForEntry: () => [],
  });
  assert.deepEqual(
    plan.inputs.map((item) => [item.type, item.record.type, item.record.record.attempt_id.value]),
    [
      ["archive", "sampling_started", "attempt-0"],
      ["archive", "sampling_commit", "attempt-0"],
    ],
  );
  assert.equal(plan.inputs[1].record.record.commit_id.value, "commit-0");
  assert.equal("record_digest" in STARTED.record, false);
  assert.equal("record_digest" in COMMIT.record, false);
});

test("Pi replay accepts a trailing sampling_started record without a later commit", () => {
  const plan = buildPiReplayPlan({
    currentSessionId: "origin-session",
    branch: [
      { type: "message", messages: [{ role: "user", content: "request", timestamp: 1 }] },
      archive(STARTED),
    ],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  assert.deepEqual(plan.inputs.map(({ type }) => type), ["source", "archive"]);
  assert.equal(plan.inputs[1].record.type, "sampling_started");
});

test("Pi replay rejects a commit whose durabilityId is the attempt id", () => {
  assert.throws(
    () => buildPiReplayPlan({
      currentSessionId: "session",
      branch: [archive(COMMIT, COMMIT.record.attempt_id.value)],
      messagesForEntry: () => [],
    }),
    PiSessionRecoveryError,
  );
});

test("Pi replay rejects digest-keyed durabilityId", () => {
  const started = {
    type: "sampling_started",
    record: { ...STARTED.record, record_digest: "started-digest" },
  };
  const commit = {
    type: "sampling_commit",
    record: { ...COMMIT.record, record_digest: "commit-digest" },
  };
  assert.throws(
    () => buildPiReplayPlan({
      currentSessionId: "origin-session",
      branch: [
        archive(started, started.record.record_digest),
        archive(commit, commit.record.record_digest),
      ],
      messagesForEntry: () => [],
    }),
    PiSessionRecoveryError,
  );
});

test("Pi replay restores compact replacement bindings and resumes boundaries", () => {
  const oldMessage = { role: "user", content: "old", timestamp: 1 };
  const summary = { role: "compactionSummary", summary: "checkpoint", tokensBefore: 4, timestamp: 2 };
  const kept = { role: "user", content: "kept", timestamp: 3 };
  const next = { role: "user", content: "next", timestamp: 4 };
  const compact = {
    type: "custom",
    customType: PI_COMPACT_ENTRY_TYPE,
    data: {
      schema: PI_ADAPTER_ID,
      barrier: {
        schema: "spine.compact.barrier.v1",
        thread: "origin-session",
        previous_epoch: 0,
        next_epoch: 1,
        boundary: 2,
        replacement_boundaries: [3, 4],
        replacement_digest: "0".repeat(64),
      },
      replacementMessages: [summary, kept],
    },
  };
  const plan = buildPiReplayPlan({
    currentSessionId: "origin-session",
    branch: [
      { type: "message", messages: [oldMessage] },
      compact,
      PI_COMPACTION_FIXTURE,
      { type: "message", messages: [next] },
    ],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  assert.deepEqual(plan.inputs.map(({ type }) => type), ["source", "compact", "source"]);
  assert.deepEqual(plan.sources.map(({ boundary, message }) => [boundary, message]), [
    [3, summary],
    [4, kept],
    [5, next],
  ]);
});

test("Pi replay keeps compact replacement entry ids and the compaction entry id", () => {
  const summary = { role: "compactionSummary", summary: "checkpoint", tokensBefore: 4, timestamp: 2 };
  const kept = { role: "user", content: "kept", timestamp: 3 };
  const plan = buildPiReplayPlan({
    currentSessionId: "origin-session",
    branch: [
      { type: "message", id: "old", messages: [{ role: "user", content: "old", timestamp: 1 }] },
      {
        type: "custom",
        customType: PI_COMPACT_ENTRY_TYPE,
        data: {
          schema: PI_ADAPTER_ID,
          barrier: {
            schema: "spine.compact.barrier.v1",
            thread: "origin-session",
            previous_epoch: 0,
            next_epoch: 1,
            boundary: 1,
            replacement_boundaries: [2, 3],
            replacement_digest: "0".repeat(64),
          },
          replacementMessages: [summary, kept],
          replacementEntryIds: [null, "keep"],
        },
      },
      { type: "compaction", id: "compact-1", fromHook: true },
    ],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  assert.deepEqual(plan.sources.map((source) => source.entryId), ["compact-1", "keep"]);
});

test("Pi replay rejects compact entry ids that do not match the replacement", () => {
  assert.throws(
    () => buildPiReplayPlan({
      currentSessionId: "origin-session",
      branch: [{
        type: "custom",
        customType: PI_COMPACT_ENTRY_TYPE,
        data: {
          schema: PI_ADAPTER_ID,
          barrier: {
            schema: "spine.compact.barrier.v1",
            thread: "origin-session",
            previous_epoch: 0,
            next_epoch: 1,
            boundary: 1,
            replacement_boundaries: [2],
            replacement_digest: "0".repeat(64),
          },
          replacementMessages: [{ role: "user", content: "kept", timestamp: 1 }],
          replacementEntryIds: [null, "extra"],
        },
      }],
      messagesForEntry: () => [],
    }),
    /do not match replacement messages/,
  );
});

test("Pi recovery replays a durable compact barrier before publishing replacement messages", async () => {
  const origin = createNodeSpineRuntime({ thread: "origin-session", features: ["jit", "spawn"] });
  await origin.client.execute({
    type: "observe_sources",
    characters: [{ type: "message", boundary: 0, role: "user", content: "old" }],
  });
  const barrier = buildCompactBarrier(
    (await origin.client.execute({ type: "source_snapshot" })).source,
    2,
  );
  origin.dispose();
  const summary = { role: "compactionSummary", summary: "checkpoint", tokensBefore: 4, timestamp: 2 };
  const kept = { role: "user", content: "kept", timestamp: 3 };
  const branch = [
    { type: "message", messages: [{ role: "user", content: "old", timestamp: 1 }] },
    {
      type: "custom",
      customType: PI_COMPACT_ENTRY_TYPE,
      data: { schema: PI_ADAPTER_ID, barrier, replacementMessages: [summary, kept] },
    },
    { type: "compaction", fromHook: true },
  ];
  const plan = buildPiReplayPlan({
    currentSessionId: "origin-session",
    branch,
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  const installed = [];
  const runtimes = [];
  const recovered = await recoverPiSession({
    plan,
    runtimeFactory(thread) {
      const runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
      runtimes.push(runtime);
      return runtime.client;
    },
    async adapterFactory(runtime, bindings) {
      return createPiSpineAdapter({
        enabled: true,
        runtime,
        host: {
          async claimOwnership() {},
          async appendCustomEntry() {},
          async materializeContext(context) {
            return materializePiContext(context, bindings);
          },
          async replaceContext(context) {
            installed.push(context.messages);
          },
        },
      });
    },
  });
  assert.equal(recovered.source.epoch, 1);
  assert.deepEqual(installed.at(-1), [summary, kept]);
  for (const runtime of runtimes) runtime.dispose();
});

test("Pi replay rejects an unacknowledged or non-hook compact entry", () => {
  const compact = {
    type: "custom",
    customType: PI_COMPACT_ENTRY_TYPE,
    data: {
      schema: PI_ADAPTER_ID,
      barrier: {
        schema: "spine.compact.barrier.v1",
        thread: "session",
        previous_epoch: 0,
        next_epoch: 1,
        boundary: 1,
        replacement_boundaries: [2],
        replacement_digest: "0".repeat(64),
      },
      replacementMessages: [{ role: "compactionSummary", summary: "checkpoint", tokensBefore: 1, timestamp: 1 }],
    },
  };
  const build = (branch) => buildPiReplayPlan({
    currentSessionId: "session",
    branch,
    messagesForEntry: () => [],
  });
  assert.throws(() => build([compact]), /missing its native compaction acknowledgement/);
  assert.throws(() => build([compact, { type: "compaction", fromHook: false }]), /not owned by the Spine hook/);
});

test("Pi session recovery installs exact bindings before publication then continues a fork", async () => {
  const messages = [
    { role: "user", content: "request", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
  ];
  const plan = buildPiReplayPlan({
    currentSessionId: "fork-session",
    branch: [
      { type: "message", messages: [messages[0]] },
      archive(STARTED),
      { type: "message", messages: [messages[1]] },
      archive(COMMIT),
    ],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  const log = [];
  const originalSource = source("origin-session", messages);
  const continuedSource = source("fork-session", messages);

  const recovered = await recoverPiSession({
    plan,
    runtimeFactory(thread) {
      log.push(`runtime:${thread}`);
      return { execute() { throw new Error("unused"); } };
    },
    async adapterFactory(_runtime, bindings) {
      return {
        async replayWithSources(_inputs, install) {
          log.push("replay");
          await install(originalSource);
          assert.deepEqual(bindings.resolve(originalSource.cells[0].source_id), messages[0]);
          log.push("publish-replay");
          return { context: {}, source: originalSource };
        },
        async continueNamespace(thread) {
          log.push(`continue:${thread}`);
          return continuedSource;
        },
        async previewAndPublish() {
          assert.deepEqual(bindings.resolve(continuedSource.cells[1].source_id), messages[1]);
          log.push("publish-preview");
          return {};
        },
      };
    },
  });

  assert.equal(recovered.source.thread, "fork-session");
  assert.deepEqual(log, [
    "runtime:origin-session",
    "replay",
    "publish-replay",
    "continue:fork-session",
    "publish-preview",
  ]);
});

test("source binding installation fails closed on a mismatched snapshot", () => {
  const bindings = new PiSourceBindings();
  assert.throws(
    () => installSourceBindings(bindings, source("session", []), [
      { boundary: 0, message: { role: "user", content: "x", timestamp: 1 } },
    ]),
    PiSessionRecoveryError,
  );
});

test("Pi replay admits a durable arrival message as a typed arrival source", () => {
  const arrival = { producer: [0, 1], outcome: "completed", memory: "child memory" };
  const plan = buildPiReplayPlan({
    currentSessionId: "session",
    branch: [{
      type: "custom_message",
      messages: [{
        role: "custom",
        customType: "spine.arrival",
        content: "<spine_arrival/>",
        display: true,
        timestamp: 1,
        details: { schema: "spine.pi.arrival/v1", arrival },
      }],
    }],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  assert.deepEqual(plan.inputs, [{ type: "source", character: { type: "arrival", boundary: 0, arrival } }]);
});

test("Pi replay skips host system messages before assigning source boundaries", () => {
  const plan = buildPiReplayPlan({
    currentSessionId: "session",
    branch: [{
      type: "message",
      messages: [
        { role: "system", content: "", timestamp: 1 },
        { role: "user", content: "request", timestamp: 2 },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], isError: false, timestamp: 3 },
      ],
    }],
    messagesForEntry: (entry) => entry.messages ?? [],
  });
  assert.deepEqual(plan.inputs.map(({ type }) => type), ["source", "source"]);
  assert.deepEqual(plan.sources.map(({ boundary, message }) => [boundary, message.role]), [
    [0, "user"],
    [1, "toolResult"],
  ]);
});
