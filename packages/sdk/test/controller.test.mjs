import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpineController,
  packReplayApplyBatches,
  SpineController,
  SpineControllerError,
} from "../dist/host/index.js";

const RECORD = {
  type: "sampling_started",
  record: {
    schema: "spine.sampling.started",
    attempt_id: { thread: "thread-1", value: "attempt-1" },
    epoch: 0,
    pre_boundary: { thread: "thread-1", epoch: 0, ordinal: 0 },
    previous_commit_id: null,
    prompt_digest: "prompt",
    source_digest: "source",
    record_digest: "start-record",
  },
};

const COMMIT = {
  type: "sampling_commit",
  record: {
    schema: "spine.sampling.commit",
    attempt_id: { thread: "thread-1", value: "attempt-1" },
    started_record_digest: "start-record",
    commit_id: { thread: "thread-1", value: "commit-1" },
    epoch: 0,
    previous_pre_boundary: null,
    pre_boundary: { thread: "thread-1", epoch: 0, ordinal: 0 },
    post_boundary: { thread: "thread-1", epoch: 0, ordinal: 1 },
    previous_commit_id: null,
    executions: [],
    source_digest: "source",
    record_digest: "commit-record",
  },
};
const PLAN = {
  schema: "spine.context.plan.v2",
  thread: "thread-1",
  epoch: 0,
  source_snapshot_digest: "source",
  cells: [],
  plan_digest: "plan",
};
const PROJECTION = { nodes: [], cursor: [], visible_context: [], last_boundary: null };
const SOURCE = {
  schema: "spine.source.snapshot.v1",
  thread: "thread-1",
  epoch: 0,
  cells: [],
};
const BARRIER = {
  schema: "spine.compact.barrier.v1",
  thread: "thread-1",
  previous_epoch: 0,
  next_epoch: 1,
  boundary: 0,
  replacement_boundaries: [1],
  replacement_digest: "barrier-digest",
};

function runtimeWith(log, overrides = {}) {
  return {
    async execute(command) {
      log.push(`runtime:${command.type}`);
      if (overrides[command.type]) {
        return overrides[command.type](command);
      }
      switch (command.type) {
        case "begin_sampling":
          return { type: "sampling_started", record: RECORD };
        case "register_execution":
          return { type: "execution_registered" };
        case "prepare_finish":
          return {
            type: "finish_prepared",
            transaction_id: "commit-1",
            record: COMMIT,
            context_plan: PLAN,
            projection: PROJECTION,
          };
        case "install_prepared":
          return {
            type: "prepared_installed",
            transaction_id: command.transaction_id,
            context_plan: PLAN,
            projection: PROJECTION,
          };
        case "discard_prepared":
          return { type: "prepared_discarded", transaction_id: command.transaction_id };
        case "preview":
          return { type: "preview", context_plan: PLAN, projection: PROJECTION };
        case "replay_begin":
          return { type: "replay_begun" };
        case "replay_apply":
          return { type: "replay_applied" };
        case "replay_finish":
          return {
            type: "replay_installed",
            context_plan: PLAN,
            projection: PROJECTION,
            applied_commits: [],
            source: SOURCE,
          };
        case "source_snapshot":
          return { type: "source_snapshot", source: SOURCE };
        case "continue_namespace":
          return {
            type: "namespace_continued",
            source: { ...SOURCE, thread: command.thread },
          };
        default:
          throw new Error(`unexpected command ${command.type}`);
      }
    },
  };
}

function ports(log, options = {}) {
  return {
    archive: {
      async persist(entry) {
        log.push(`persist:${entry.durabilityId}`);
        const atStart = entry.durabilityId === "attempt-1";
        const shouldFail = options.persistErrorAt === "start" ? atStart : !atStart;
        if (options.persistError && shouldFail) throw options.persistError;
      },
    },
    context: {
      async publish(context) {
        log.push(`publish:${context.transactionId}`);
        if (options.publishError) throw options.publishError;
      },
    },
  };
}

test("finish persists before install and publishes only after install", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await controller.beginSampling();
  const result = await controller.finishSampling({ terminal: "completed", inputTokens: 42 });

  assert.equal(result.type, "committed");
  assert.deepEqual(log, [
    "runtime:begin_sampling",
    "persist:attempt-1",
    "runtime:prepare_finish",
    "persist:commit-1",
    "runtime:install_prepared",
    "publish:commit-1",
  ]);
});

test("uncertain persistence failure discards prepared state and fault-latches", async () => {
  const log = [];
  const persistError = new Error("durability acknowledgement lost");
  const host = ports(log, { persistError });
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await controller.beginSampling();
  await assert.rejects(
    controller.finishSampling({ terminal: "completed" }),
    (error) => error instanceof SpineControllerError && error.fault.stage === "persist",
  );
  assert.deepEqual(log, [
    "runtime:begin_sampling",
    "persist:attempt-1",
    "runtime:prepare_finish",
    "persist:commit-1",
    "runtime:discard_prepared",
  ]);
  await assert.rejects(controller.preview(), SpineControllerError);
});

test("discard failure remains secondary to uncertain persistence", async () => {
  const log = [];
  const host = ports(log, { persistError: new Error("persistence uncertain") });
  const runtime = runtimeWith(log, {
    discard_prepared() {
      throw new Error("discard failed");
    },
  });
  const controller = new SpineController(runtime, host.archive, host.context);

  await controller.beginSampling();
  await assert.rejects(
    controller.finishSampling({ terminal: "completed" }),
    (error) =>
      error instanceof SpineControllerError &&
      error.fault.stage === "persist" &&
      error.fault.cause instanceof AggregateError,
  );
});

test("started-record persistence failure latches before sampling work proceeds", async () => {
  const log = [];
  const host = ports(log, {
    persistError: new Error("started record unavailable"),
    persistErrorAt: "start",
  });
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await assert.rejects(
    controller.beginSampling(),
    (error) => error instanceof SpineControllerError && error.fault.stage === "persist",
  );
  assert.deepEqual(log, ["runtime:begin_sampling", "persist:attempt-1"]);
  await assert.rejects(controller.preview(), SpineControllerError);
});

test("controller serializes sampling work behind started-record persistence", async () => {
  const log = [];
  const persisted = Promise.withResolvers();
  const host = ports(log);
  host.archive.persist = async (entry) => {
    log.push(`persist:${entry.durabilityId}`);
    if (entry.durabilityId === "attempt-1") await persisted.promise;
  };
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  const begin = controller.beginSampling();
  const register = controller.registerExecution("open-0");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["runtime:begin_sampling", "persist:attempt-1"]);

  persisted.resolve();
  await Promise.all([begin, register]);
  assert.deepEqual(log.at(-1), "runtime:register_execution");
});

test("publication failure latches after the durable commit is installed", async () => {
  const log = [];
  const host = ports(log, { publishError: new Error("surface unavailable") });
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await controller.beginSampling();
  await assert.rejects(
    controller.finishSampling({ terminal: "completed" }),
    (error) => error instanceof SpineControllerError && error.fault.stage === "publish",
  );
  assert.deepEqual(log.slice(-3), [
    "persist:commit-1",
    "runtime:install_prepared",
    "publish:commit-1",
  ]);
});

test("compact persists before runtime mutation and publishes the returned projection", async () => {
  const log = [];
  const host = ports(log);
  host.archive.persistCompact = async () => log.push("persist:compact");
  const controller = new SpineController(runtimeWith(log, {
    compact() {
      return { type: "compacted", context_plan: PLAN, projection: PROJECTION };
    },
  }), host.archive, host.context);

  const result = await controller.compact(BARRIER);
  assert.equal(result.contextPlan, PLAN);
  assert.deepEqual(log, ["persist:compact", "runtime:compact", "publish:null"]);
});

test("compact result-shape failure latches the controller after persistence", async () => {
  const log = [];
  const host = ports(log);
  host.archive.persistCompact = async () => log.push("persist:compact");
  const controller = new SpineController(runtimeWith(log, {
    compact() {
      return { type: "preview", context_plan: PLAN, projection: PROJECTION };
    },
  }), host.archive, host.context);

  await assert.rejects(
    controller.compact(BARRIER),
    (error) => error instanceof SpineControllerError && error.fault.stage === "runtime",
  );
  assert.equal(controller.fault?.stage, "runtime");
  await assert.rejects(controller.compact(BARRIER), SpineControllerError);
});

test("replay installs through the runtime and publishes without persisting", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await controller.replay([]);
  assert.deepEqual(log, ["runtime:replay_begin", "runtime:replay_finish", "publish:null"]);
});

test("replay apply packing splits oversized batches", () => {
  const bulky = {
    type: "source",
    character: { type: "message", boundary: 1, role: "user", content: "x".repeat(700_000) },
  };
  const second = {
    type: "source",
    character: { type: "message", boundary: 2, role: "user", content: "x".repeat(700_000) },
  };
  const batches = packReplayApplyBatches([bulky, second]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[1].length, 1);
});

test("replay with packed inputs issues begin, apply, finish", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);
  const item = {
    type: "source",
    character: { type: "opaque", boundary: 1 },
  };
  await controller.replay([item]);
  assert.deepEqual(log, [
    "runtime:replay_begin",
    "runtime:replay_apply",
    "runtime:replay_finish",
    "publish:null",
  ]);
});

test("replay installs exact source bindings before publication and preview is serialized", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  const replayed = await controller.replayWithSources([], async (source) => {
    log.push(`restore:${source.thread}`);
  });
  assert.equal(replayed.source, SOURCE);
  const preview = await controller.previewAndPublish();
  assert.equal(preview.contextPlan, PLAN);
  assert.deepEqual(log, [
    "runtime:replay_begin",
    "runtime:replay_finish",
    "restore:thread-1",
    "publish:null",
    "runtime:preview",
    "publish:null",
  ]);
});

test("replay source binding failure fault-latches before publication", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  await assert.rejects(
    controller.replayWithSources([], async () => {
      throw new Error("binding mismatch");
    }),
    (error) => error instanceof SpineControllerError && error.fault.stage === "restore",
  );
  assert.deepEqual(log, ["runtime:replay_begin", "runtime:replay_finish"]);
  await assert.rejects(controller.preview(), SpineControllerError);
});

test("source snapshot and namespace continuation stay inside the operation queue", async () => {
  const log = [];
  const host = ports(log);
  const controller = new SpineController(runtimeWith(log), host.archive, host.context);

  assert.equal(await controller.sourceSnapshot(), SOURCE);
  const continued = await controller.continueNamespace("thread-2");
  assert.equal(continued.thread, "thread-2");
  assert.deepEqual(log, ["runtime:source_snapshot", "runtime:continue_namespace"]);
});

test("feature off returns no controller and touches no host port", () => {
  const options = {
    enabled: false,
    get runtime() { throw new Error("runtime accessed"); },
    get archive() { throw new Error("archive accessed"); },
    get context() { throw new Error("context accessed"); },
  };

  assert.equal(createSpineController(options), null);
});
