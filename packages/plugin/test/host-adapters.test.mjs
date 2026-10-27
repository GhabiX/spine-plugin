import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPiSpineAdapter } from "../dist/pi/index.js";

const trace = JSON.parse(
  await readFile(new URL("../../../fixtures/conformance/open-trace.json", import.meta.url)),
);

const STARTED = {
  type: "sampling_started",
  record: {
    schema: "spine.sampling.started",
    attempt_id: { thread: "thread-1", value: "attempt-1" },
    epoch: 0,
    pre_boundary: { thread: "thread-1", epoch: 0, ordinal: 1 },
    previous_commit_id: null,
    prompt_digest: trace.promptDigest,
    source_digest: "source-digest-1",
    record_digest: "started-digest-1",
  },
};
const COMMIT = {
  type: "sampling_commit",
  record: {
    schema: "spine.sampling.commit",
    attempt_id: { thread: "thread-1", value: "attempt-1" },
    started_record_digest: "started-digest-1",
    commit_id: { thread: "thread-1", value: "commit-1" },
    epoch: 0,
    previous_pre_boundary: null,
    pre_boundary: { thread: "thread-1", epoch: 0, ordinal: 1 },
    post_boundary: { thread: "thread-1", epoch: 0, ordinal: 2 },
    previous_commit_id: null,
    executions: [],
    source_digest: "source-digest-1",
    record_digest: "commit-digest-1",
  },
};
const PLAN = {
  schema: "spine.context.plan.v2",
  thread: "thread-1",
  epoch: 0,
  source_snapshot_digest: "source-digest-1",
  cells: [],
  plan_digest: "plan-digest-1",
};
const PROJECTION = {
  nodes: [],
  cursor: [],
  visible_context: [],
  last_boundary: 2,
};

function runtime(log) {
  return {
    async execute(command) {
      log.push(["runtime", command.type]);
      switch (command.type) {
        case "observe_sources":
          return {
            type: "sources_observed",
            source_ids: [{ thread: "thread-1", epoch: 0, ordinal: 0 }],
          };
        case "begin_sampling":
          return { type: "sampling_started", record: STARTED };
        case "register_execution":
          return { type: "execution_registered" };
        case "stage_execution":
          return { type: "execution_staged" };
        case "finish_execution":
          return { type: "execution_finished" };
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
        default:
          throw new Error(`unexpected command ${command.type}`);
      }
    },
  };
}

function hostRecorder(log) {
  return {
    async claimOwnership(claim) {
      log.push(["ownership", claim]);
    },
    async materializeContext(context) {
      log.push(["materialize", context.contextPlan?.plan_digest ?? null]);
      return [{ role: "user", content: "materialized-context" }];
    },
    async appendCustomEntry(type, entry) {
      log.push(["archive", type, entry]);
    },
    async replaceContext(context) {
      log.push(["context", context]);
    },
  };
}

async function runTrace() {
  const log = [];
  const adapter = await createPiSpineAdapter({ enabled: true, runtime: runtime(log), host: hostRecorder(log) });

  const sourceIds = await adapter.observeSources(trace.sources);
  assert.deepEqual(sourceIds, [{ thread: "thread-1", epoch: 0, ordinal: 0 }]);
  await adapter.beginSampling();
  await adapter.observeSources(trace.samplingSources);
  await adapter.registerExecution(trace.execution.key);
  await adapter.stageExecution(
    trace.execution.key,
    trace.execution.executionRef,
    trace.execution.operation,
  );
  await adapter.finishExecution(trace.execution.key, true);
  await adapter.finishSampling(trace.terminal);
  return log;
}

function semanticOutcome(log) {
  return {
    ownership: log.find(([kind]) => kind === "ownership")[1],
    archives: log
      .filter(([kind]) => kind === "archive")
      .map(([, , entry]) => ({ durabilityId: entry.durabilityId, record: entry.record })),
    context: log.find(([kind]) => kind === "context").at(-1),
  };
}

test("Pi persists the commit before install and publishes after install", async () => {
  const pi = await runTrace();
  assert.deepEqual(
    semanticOutcome(pi).archives.map(({ durabilityId }) => durabilityId),
    ["attempt-1", "commit-1"],
  );
  const install = pi.findIndex((entry) => entry[0] === "runtime" && entry[1] === "install_prepared");
  const commit = pi.findIndex(
    (entry) => entry[0] === "archive" && entry[2].durabilityId === "commit-1",
  );
  const publish = pi.findIndex((entry) => entry[0] === "context");
  assert.ok(commit < install && install < publish);
});

test("Pi compact adapter requires replacement metadata before persistence", async () => {
  const log = [];
  const adapter = await createPiSpineAdapter({
    enabled: true,
    runtime: {
      async execute(command) {
        log.push(command.type);
        return {
          type: "compacted",
          context_plan: PLAN,
          projection: PROJECTION,
        };
      },
    },
    host: {
      async claimOwnership() {},
      async appendCustomEntry() { log.push("persist"); },
      async materializeContext() { return []; },
      async replaceContext() {},
    },
  });
  await assert.rejects(
    adapter.compact({
      schema: "spine.compact.barrier.v1",
      thread: "thread-1",
      previous_epoch: 0,
      next_epoch: 1,
      boundary: 0,
      replacement_boundaries: [1],
      replacement_digest: "digest",
    }),
    (error) => /replacement metadata/.test(String(error?.fault?.cause ?? error)),
  );
  assert.deepEqual(log, []);
});

test("disabled host adapters preserve host identity", async () => {
  const options = {
    enabled: false,
    get runtime() { throw new Error("runtime accessed"); },
    get host() { throw new Error("host accessed"); },
  };

  assert.equal(await createPiSpineAdapter(options), null);
});
