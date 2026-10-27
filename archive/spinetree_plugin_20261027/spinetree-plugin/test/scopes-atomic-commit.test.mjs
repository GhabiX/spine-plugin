import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { SpineController } from "@spinejit/pi-spinejit";
import { commitSpineTreeScopes, GitSpineTreeStore, GitSpineTreeAgentRegistry,
  MemorySpineTreeStore, SpineTreeChangeError } from "../dist/index.js";

const home = { id: "home", parent: null, goal: "project", constraints: [], skills: [], tools: [],
  memory: null, memoryVersion: 0, memorySource: null, status: "live" };
const binding = { agentId: "a", sessionId: "pi-a", branch: "home", status: "running",
  bindingId: "binding-a", leaseId: "lease-a", operationId: "operation-a", epoch: 0, scopeCursor: [0] };
const initial = () => ({ schema: "spinetree.snapshot/v2", branches: { home }, registry: { a: binding } });
const snapshot = store => store.readSnapshot(store.head());

async function canonical(t) {
  const runtime = createNodeSpineRuntime({ thread: "atomic-a", features: ["jit", "spawn"] });
  t.after(() => runtime.dispose());
  const controller = new SpineController(runtime.client, { async persist() {} }, { async publish() {} });
  await controller.observeSources([{ type: "message", boundary: 0, role: "user", content: "atomic work" }]);
  let boundary = 0;
  return async operation => {
    await controller.beginSampling();
    const key = `call-${++boundary}`;
    if (operation) await controller.registerExecution(key);
    await controller.observeSources([{ type: "message", boundary, role: "assistant", content: "work" }]);
    if (operation) { await controller.stageExecution(key, key, operation); await controller.finishExecution(key, true); }
    const result = await controller.finishSampling({ terminal: "completed" });
    assert.equal(result.type, "committed");
    return { agentId: binding.agentId, sessionId: binding.sessionId,
      transactionId: result.transactionId, record: result.record.record, projection: result.projection,
      binding: { ...binding, epoch: result.record.record.epoch, scopeCursor: result.projection.cursor },
      alignment: "one-to-one" };
  };
}

function counted(store, intercept = () => {}) {
  let attempts = 0, writes = 0;
  return {
    head: () => store.head(), readSnapshot: head => store.readSnapshot(head),
    async commitSnapshot(head, draft, message) {
      await intercept(++attempts, head, draft);
      const result = await store.commitSnapshot(head, draft, message);
      writes += 1;
      return result;
    },
    counts: () => ({ attempts, writes }),
  };
}

for (const kind of ["Memory", "Git"]) test(`${kind}: cursor, mapping, memory and watermark publish once per sampling`, async t => {
  const sample = await canonical(t);
  const store = kind === "Memory" ? new MemorySpineTreeStore(initial())
    : GitSpineTreeStore.initialize(await mkdtemp(join(tmpdir(), "atomic-scopes-")), initial());
  const countedStore = counted(store);
  let id;
  for (const [index, operation] of [
    { type: "open", summary: "accepted work" }, undefined, { type: "close", memory: "verified result" },
  ].entries()) {
    const receipt = await sample(operation);
    const before = store.head();
    const result = await commitSpineTreeScopes({ store: countedStore, ...receipt });
    assert.notEqual(result.head, before);
    assert.equal(result.replayed, false);
    assert.deepEqual(result.binding, snapshot(store).registry.a);
    assert.deepEqual(result.binding.scopeCursor, receipt.projection.cursor);
    assert.equal(result.binding.branch, "home");
    id ??= result.selections[0].branch;
    assert.equal(snapshot(store).branches[id].parent, "home");
    const watermark = snapshot(store).scopeImports[JSON.stringify(["pi-a", "atomic-a"])];
    assert.equal(watermark.commitId, receipt.record.commit_id.value);
    assert.deepEqual(countedStore.counts(), { attempts: index + 1, writes: index + 1 });
    const replay = await commitSpineTreeScopes({ store: countedStore, ...receipt });
    assert.equal(replay.replayed, true);
    assert.equal(replay.head, result.head);
    assert.deepEqual(replay.binding, result.binding);
  }
  assert.equal(snapshot(store).branches[id].status, "capped");
  assert.equal(snapshot(store).branches[id].memoryVersion, 1);
  assert.equal(snapshot(store).branches.home.memoryVersion, 0);
});

test("invalid mapping and storage failure leave the original cursor and entire snapshot unchanged", async t => {
  const sample = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  const before = snapshot(store), head = store.head();
  const countedStore = counted(store);
  await assert.rejects(commitSpineTreeScopes({ store: countedStore, ...receipt,
    selections: [{ nodeId: receipt.projection.cursor, branch: "missing" }] }), { code: "unknown-branch" });
  assert.deepEqual(countedStore.counts(), { attempts: 0, writes: 0 });
  await assert.rejects(commitSpineTreeScopes({ store: counted(store, () => { throw new Error("storage unavailable"); }), ...receipt }), /storage unavailable/);
  assert.equal(store.head(), head);
  assert.deepEqual(snapshot(store), before);
});

test("CAS retry preserves unrelated edits and publishes only its final identity", async t => {
  const sample = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  const countedStore = counted(store, (attempt, head) => {
    if (attempt === 1) store.change(head, [{ type: "update", branch: "home", attributes: { goal: "concurrent edit" } }]);
  });
  const result = await commitSpineTreeScopes({ store: countedStore, ...receipt });
  assert.deepEqual(countedStore.counts(), { attempts: 2, writes: 1 });
  assert.equal(snapshot(store).branches.home.goal, "concurrent edit");
  assert.deepEqual(Object.keys(snapshot(store).branches).sort(), ["home", result.selections[0].branch].sort());
  assert.deepEqual(snapshot(store).registry.a, result.binding);
});

for (const transition of ["paused", "ended", "replaced"]) test(`owner ${transition} during CAS retry forbids cursor and import publication`, async t => {
  const sample = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  let concurrent;
  const countedStore = counted(store, (attempt, head) => {
    assert.equal(attempt, 1);
    concurrent = snapshot(store);
    if (transition === "replaced") concurrent.registry.a.leaseId = "replacement";
    else concurrent.registry.a.status = transition;
    store.commitSnapshot(head, concurrent);
  });
  await assert.rejects(commitSpineTreeScopes({ store: countedStore, ...receipt }), { code: "binding-conflict" });
  assert.deepEqual(countedStore.counts(), { attempts: 1, writes: 0 });
  assert.deepEqual(snapshot(store), concurrent);
});

test("same receipt concurrent imports converge on one write and one branch identity", async t => {
  const sample = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const countedStore = counted(store);
  const receipt = await sample({ type: "open", summary: "work" });
  const results = await Promise.all([1, 2].map(() => commitSpineTreeScopes({ store: countedStore, ...receipt })));
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  assert.equal(countedStore.counts().writes, 1);
  assert.deepEqual(results[0].selections, results[1].selections);
  assert.deepEqual(results[0].binding, results[1].binding);
});

test("different receipts racing for one commit reject the loser without changing the winning snapshot", async t => {
  const sample = await canonical(t), store = new MemorySpineTreeStore(initial());
  const winner = await sample({ type: "open", summary: "work" });
  const loser = { ...winner, transactionId: "different-transaction" };
  let accepted;
  const countedStore = counted(store, async attempt => {
    assert.equal(attempt, 1);
    await commitSpineTreeScopes({ store, ...winner });
    accepted = snapshot(store);
  });
  await assert.rejects(commitSpineTreeScopes({ store: countedStore, ...loser }), { code: "conflicting-replay" });
  assert.deepEqual(countedStore.counts(), { attempts: 1, writes: 0 });
  assert.deepEqual(snapshot(store), accepted);
});

test("a real successor retries against a concurrently accepted predecessor and preserves its identity", async t => {
  const sample = await canonical(t), store = new MemorySpineTreeStore(initial());
  const first = await sample({ type: "open", summary: "work" });
  const next = await sample({ type: "close", memory: "accepted result" });
  let firstResult;
  const countedStore = counted(store, async attempt => {
    if (attempt === 1) firstResult = await commitSpineTreeScopes({ store, ...first });
  });
  const result = await commitSpineTreeScopes({ store: countedStore, ...next });
  const id = firstResult.selections[0].branch;
  assert.deepEqual(result.selections, firstResult.selections);
  assert.deepEqual(countedStore.counts(), { attempts: 2, writes: 1 });
  assert.deepEqual(Object.keys(snapshot(store).branches).sort(), ["home", id].sort());
  assert.equal(snapshot(store).branches[id].memoryVersion, 1);
  assert.equal(snapshot(store).branches[id].status, "capped");
  assert.deepEqual(result.binding.scopeCursor, next.projection.cursor);
  const head = store.head();
  await assert.rejects(commitSpineTreeScopes({ store, ...first }), { code: "stale-commit" });
  assert.equal(store.head(), head);
});

for (const replacement of ["absent", "new-lease"]) test(`old receipt replay observes ${replacement} registry without restoring its binding`, async t => {
  const sample = await canonical(t), store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  await commitSpineTreeScopes({ store, ...receipt });
  const next = snapshot(store);
  next.registry = replacement === "absent" ? {} : { a: { ...binding,
    sessionId: "replacement-session", bindingId: "replacement-binding", leaseId: "replacement-lease" } };
  store.commitSnapshot(store.head(), next);
  const head = store.head(), before = snapshot(store), countedStore = counted(store);
  const replay = await commitSpineTreeScopes({ store: countedStore, ...receipt });
  assert.equal(replay.replayed, true);
  assert.equal(replay.head, head);
  assert.deepEqual(replay.binding, before.registry.a);
  assert.deepEqual(countedStore.counts(), { attempts: 0, writes: 0 });
  assert.deepEqual(snapshot(store), before);
});

for (const status of ["paused", "ended"]) test(`exact replay returns current ${status} lease without restoring old cursor`, async t => {
  const sample = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  await commitSpineTreeScopes({ store, ...receipt });
  const registry = new GitSpineTreeAgentRegistry(store);
  await registry.updateWorking("a", "lease-a", { epoch: 1, scopeCursor: [1] });
  await registry.transition("a", status);
  const head = store.head(), before = snapshot(store), countedStore = counted(store);
  const replay = await commitSpineTreeScopes({ store: countedStore, ...receipt });
  assert.equal(replay.head, head);
  assert.deepEqual(replay.binding, before.registry.a);
  assert.deepEqual(replay.binding.scopeCursor, [1]);
  assert.deepEqual(countedStore.counts(), { attempts: 0, writes: 0 });
  assert.deepEqual(snapshot(store), before);
  await assert.rejects(commitSpineTreeScopes({ store: countedStore, ...receipt,
    binding: { ...receipt.binding, leaseId: "forged" } }), { code: "conflicting-replay" });
});

test("bounded CAS exhaustion never partially publishes scope state", async t => {
  const sample = await canonical(t), store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  const before = snapshot(store);
  const countedStore = counted(store, () => { throw new SpineTreeChangeError("stale-head", "contended"); });
  await assert.rejects(commitSpineTreeScopes({ store: countedStore, ...receipt, maxCasRetries: 2 }), { code: "stale-head" });
  assert.deepEqual(countedStore.counts(), { attempts: 2, writes: 0 });
  assert.deepEqual(snapshot(store), before);
});

test("new receipt cannot regress epoch even with a matching lease", async t => {
  const sample = await canonical(t), store = new MemorySpineTreeStore(initial());
  const receipt = await sample({ type: "open", summary: "work" });
  await new GitSpineTreeAgentRegistry(store).updateWorking("a", "lease-a", { epoch: 1, scopeCursor: [1] });
  const before = snapshot(store), head = store.head();
  await assert.rejects(commitSpineTreeScopes({ store, ...receipt }), { code: "invalid-working-binding" });
  assert.equal(store.head(), head);
  assert.deepEqual(snapshot(store), before);
});
