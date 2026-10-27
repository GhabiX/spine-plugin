import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import {
  createDeepSeekHarnessSpawnStagingStore,
  createDeepSeekHarnessSpineAdapter,
  createDeepSeekHarnessSessionPort,
  createDeepSeekHarnessEventOwnerLeases,
  DeepSeekHarnessCapabilityError,
  DeepSeekHarnessDurabilityError,
  recoverDeepSeekHarnessSpawnResults,
} from "../dist/deepseek-harness/index.js";
import { createPiSpawnStagingStore, createPiSpineAdapter } from "../dist/pi/index.js";

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

function hostRecorder(kind, log) {
  const common = {
    async claimOwnership(claim) {
      log.push(["ownership", claim]);
    },
    async materializeContext(context) {
      log.push(["materialize", context.contextPlan?.plan_digest ?? null]);
      return [{ role: "user", content: "materialized-context" }];
    },
  };
  if (kind === "pi") {
    return {
      ...common,
      async appendCustomEntry(type, entry) {
        log.push(["archive", type, entry]);
      },
      async replaceContext(context) {
        log.push(["context", context]);
      },
    };
  }
  return {
    ...common,
    registerRequiredEventOwner(manifest) {
      log.push(["register", manifest]);
      return () => log.push(["unregister"]);
    },
    async appendRequiredEvent(type, entry) {
      log.push(["archive", type, entry]);
    },
    async publishAtomicSurface(context) {
      log.push(["context", "surface/projection", context]);
    },
  };
}

async function runTrace(kind) {
  const log = [];
  const options = { enabled: true, runtime: runtime(log), host: hostRecorder(kind, log) };
  const adapter = kind === "pi"
    ? await createPiSpineAdapter(options)
    : await createDeepSeekHarnessSpineAdapter(options);

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

test("Pi and DeepSeek Harness produce the same semantic outcome for one typed trace", async () => {
  const pi = await runTrace("pi");
  const dsh = await runTrace("dsh");

  assert.deepEqual(semanticOutcome(pi), semanticOutcome(dsh));
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

test("real WASM produces equivalent Pi and DSH archives and ContextPlan", async () => {
  async function run(kind) {
    const log = [];
    const node = createNodeSpineRuntime({
      thread: "cross-host-real",
      features: ["jit", "spawn"],
    });
    try {
      const host = hostRecorder(kind, log);
      const adapter = kind === "pi"
        ? await createPiSpineAdapter({ enabled: true, runtime: node.client, host })
        : await createDeepSeekHarnessSpineAdapter({ enabled: true, runtime: node.client, host });
      await adapter.observeSources(trace.sources);
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
      adapter.dispose();
      return log;
    } finally {
      node.dispose();
    }
  }

  const pi = await run("pi");
  const dsh = await run("dsh");
  assert.deepEqual(semanticOutcome(pi).archives, semanticOutcome(dsh).archives);
  assert.equal(
    semanticOutcome(pi).context.contextPlan.plan_digest,
    semanticOutcome(dsh).context.contextPlan.plan_digest,
  );
  assert.deepEqual(
    semanticOutcome(pi).context.projection,
    semanticOutcome(dsh).context.projection,
  );
});

test("DeepSeek Harness rejects missing required-event registration before side effects", async () => {
  const log = [];
  const host = hostRecorder("dsh", log);
  delete host.registerRequiredEventOwner;

  await assert.rejects(
    createDeepSeekHarnessSpineAdapter({ enabled: true, runtime: runtime(log), host }),
    (error) =>
      error instanceof DeepSeekHarnessCapabilityError &&
      error.capability === "required-event-owner",
  );
  assert.deepEqual(log, []);
});

test("DeepSeek Harness rejects missing atomic surface projection before side effects", async () => {
  const log = [];
  const host = hostRecorder("dsh", log);
  delete host.publishAtomicSurface;

  await assert.rejects(
    createDeepSeekHarnessSpineAdapter({ enabled: true, runtime: runtime(log), host }),
    (error) =>
      error instanceof DeepSeekHarnessCapabilityError &&
      error.capability === "atomic-surface-projection",
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
  assert.equal(await createDeepSeekHarnessSpineAdapter(options), null);
});

test("Pi and DeepSeek Harness durably stage the same ordered spawn terminal", async () => {
  const result = {
    ordinal: 0,
    outcome: "completed",
    memory_body: "child memory",
    execution_ref: "child-0",
  };
  const piLog = [];
  const dshLog = [];
  await createPiSpawnStagingStore(hostRecorder("pi", piLog)).persistTerminal("batch-1", result);
  await createDeepSeekHarnessSpawnStagingStore(hostRecorder("dsh", dshLog))
    .persistTerminal("batch-1", result);

  const piEntry = piLog[0][2];
  const dshEntry = dshLog[0][2];
  assert.deepEqual(
    { batchId: piEntry.batchId, result: piEntry.result },
    { batchId: dshEntry.batchId, result: dshEntry.result },
  );
});

test("concrete DeepSeek Harness port appends and flushes required records and atomic projection", async () => {
  const log = [];
  const session = {
    events: [],
    surface: { nodes: [2, 4], replaceGeneration: 3 },
    append(type, data) {
      log.push(["append", type, data]);
      this.events.push({ type, data });
      if (type === "surface/projection") {
        this.surface = { nodes: [this.events.length - 1], replaceGeneration: 4 };
      }
    },
  };
  const sessions = {
    registerRequiredEventOwner(manifest) {
      log.push(["register", manifest]);
      return () => log.push(["unregister"]);
    },
    async flush(value) {
      assert.equal(value, session);
      log.push(["flush"]);
      return true;
    },
  };
  const port = createDeepSeekHarnessSessionPort({
    session,
    sessions,
    async claimOwnership(claim) { log.push(["ownership", claim]); },
    async materializeContext() {
      return [{ id: "message-1", role: "user", content: [], source: { kind: "user" } }];
    },
  });
  const adapter = await createDeepSeekHarnessSpineAdapter({
    enabled: true,
    runtime: runtime(log),
    host: port,
  });

  await adapter.beginSampling();
  await adapter.finishSampling(trace.terminal);
  const appends = log.filter(([kind]) => kind === "append");
  assert.deepEqual(appends.map(([, type]) => type), [
    "spine/archive",
    "spine/archive",
    "surface/projection",
  ]);
  assert.deepEqual(appends.at(-1)[2], {
    owner: "spine",
    schema: "spine-plugin/deepseek-harness/v1",
    expectedGeneration: 3,
    planDigest: "thread-1:0:0",
    provenance: [2, 4],
    messages: [{ id: "message-1", role: "user", content: [], source: { kind: "user" } }],
    payload: {
      schema: "spine-host-protocol/v1",
      transactionId: "commit-1",
      contextPlan: PLAN,
      projection: PROJECTION,
      messages: [{ id: "message-1", role: "user", content: [], source: { kind: "user" } }],
    },
  });
  assert.equal(log.filter(([kind]) => kind === "flush").length, 4);
  assert.deepEqual(Object.keys(log[0][1].events), ["spine/archive", "spine/spawn-terminal"]);
  assert.throws(
    () => log[0][1].events["spine/archive"].decode({
      schema: "spine-plugin/deepseek-harness/v1",
      durabilityId: "broken",
      record: { type: "sampling_started", record: { record_digest: "broken" } },
    }),
    /archive identity|sampling-started/,
  );
  assert.throws(
    () => log[0][1].events["spine/spawn-terminal"].decode({
      schema: "spine-plugin/deepseek-harness/v1",
      batchId: "batch",
      result: { ordinal: -1, outcome: "completed", memory_body: "memory" },
    }),
    /terminal result/,
  );
  adapter.dispose();
  adapter.dispose();
  assert.equal(log.filter(([kind]) => kind === "unregister").length, 1);
});

test("concrete DeepSeek Harness port fails closed without a durability listener", async () => {
  const session = { events: [], surface: { nodes: [], replaceGeneration: 0 }, append() {} };
  const port = createDeepSeekHarnessSessionPort({
    session,
    sessions: {
      registerRequiredEventOwner() { return () => {}; },
      async flush() { return false; },
    },
    async claimOwnership() {},
    async materializeContext() { return []; },
  });
  await assert.rejects(
    createDeepSeekHarnessSpineAdapter({ enabled: true, runtime: runtime([]), host: port }),
    DeepSeekHarnessDurabilityError,
  );
});

test("concrete DeepSeek Harness port treats an empty null-plan replay as identity", async () => {
  const session = {
    events: [],
    surface: { nodes: [], replaceGeneration: 0 },
    append() { throw new Error("empty identity publication appended"); },
  };
  const port = createDeepSeekHarnessSessionPort({
    session,
    sessions: {
      registerRequiredEventOwner() { return () => {}; },
      async flush() { return true; },
    },
    async claimOwnership() {},
    async materializeContext() { return []; },
  });
  await port.publishAtomicSurface({
    schema: "spine-host-protocol/v1",
    transactionId: null,
    contextPlan: null,
    projection: { nodes: [], cursor: [], visible_context: [], last_boundary: null },
    messages: [],
  });
  assert.deepEqual(session.events, []);
});

test("DeepSeek Harness sessions share one required-event owner registration lease", () => {
  let registrations = 0;
  let disposals = 0;
  const lease = createDeepSeekHarnessEventOwnerLeases(() => {
    registrations += 1;
    return () => { disposals += 1; };
  });
  const manifest = {
    owner: "spine",
    schema: "spine-plugin/deepseek-harness/v1",
    events: {
      "spine/archive": { decode() {} },
      "spine/spawn-terminal": { decode() {} },
    },
  };
  const first = lease(manifest);
  const second = lease(manifest);
  assert.equal(registrations, 1);
  first();
  assert.equal(disposals, 0);
  second();
  assert.equal(disposals, 1);
});

test("DeepSeek Harness recovers only a complete ordered durable Spawn receipt", () => {
  const tasks = [
    { summary: "first", prompt: "one" },
    { summary: "second", prompt: "two" },
  ];
  const terminal = (ordinal, memory) => ({
    schema: "spine-plugin/deepseek-harness/v1",
    batchId: "batch-1",
    result: { ordinal, outcome: "completed", memory_body: memory },
  });
  const events = [
    { type: "spine/spawn-terminal", data: terminal(1, "second memory") },
    { type: "spine/spawn-terminal", data: terminal(0, "first memory") },
  ];
  assert.deepEqual(
    recoverDeepSeekHarnessSpawnResults(events, "batch-1", tasks).map((result) => result.memory_body),
    ["first memory", "second memory"],
  );
  assert.throws(
    () => recoverDeepSeekHarnessSpawnResults(events.slice(0, 1), "batch-1", tasks),
    /incomplete/,
  );
});
