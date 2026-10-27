import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { SpineController } from "@spinejit/pi-spinejit";
import { commitSpineTreeScopes, GitSpineTreeStore, GitSpineTreeAgentRegistry } from "../dist/index.js";

const oldScope = { agentId: "old", sessionId: "old-session", thread: "old-thread", epoch: 0, nodeId: [0, 1] };
const branch = { id: "child", parent: "root", goal: "refine", constraints: [], skills: [], tools: [], memory: "v1", memoryVersion: 1,
  memorySource: { ...oldScope, schema: "spinetree.scope.memory/v1", commitId: { thread: "old-thread", value: "old-commit" } }, scopeBinding: oldScope, status: "capped" };
async function fixture(t) {
  const temp = process.env.SPINETREE_TEST_TEMP ?? resolve("temp/null/20260926_2002/reexecution"); await mkdir(temp, { recursive: true });
  const path = await mkdtemp(join(temp, "canonical-"));
  const store = GitSpineTreeStore.initialize(path, { branches: { root: { ...branch, id: "root", parent: null, status: "live", scopeBinding: undefined }, child: branch }, schema: "spinetree.snapshot/v2" });
  const registry = new GitSpineTreeAgentRegistry(store);
  const result = await registry.rejuvenate({ parent: "root", branch: "child" }, { provision: context => ({ agentId: "new", sessionId: "new-session", branch: "child", status: "running", bindingId: "binding", leaseId: "lease", operationId: context.executionId, epoch: 0, scopeCursor: [0] }) });
  const runtime = createNodeSpineRuntime({ thread: "new-thread", features: ["jit", "spawn"] }); t.after(() => runtime.dispose());
  const controller = new SpineController(runtime.client, { async persist() {} }, { async publish() {} });
  await controller.observeSources([{ type: "message", boundary: 0, role: "user", content: "refine from v1" }]);
  let boundary = 0;
  const sample = async operation => {
    await controller.beginSampling(); const key = `call-${++boundary}`;
    if (operation) await controller.registerExecution(key);
    await controller.observeSources([{ type: "message", boundary, role: "assistant", content: "iteration" }]);
    if (operation) { await controller.stageExecution(key, key, operation); await controller.finishExecution(key, true); }
    const commit = await controller.finishSampling({ terminal: "completed" });
    const binding = await registry.updateWorking("new", "lease", { epoch: commit.record.record.epoch, scopeCursor: commit.projection.cursor });
    return { store, agentId: "new", sessionId: "new-session", binding, transactionId: commit.transactionId,
      record: commit.record.record, projection: commit.projection, alignment: "one-to-one" };
  };
  return { store, registry, path, result, sample };
}

test("new canonical close revises the same branch v1->v2; nested work, final message and reload replay remain valid", async t => {
  const f = await fixture(t);
  const open = await f.sample({ type: "open", summary: "reexecute" });
  const mapped = await commitSpineTreeScopes(open);
  assert.equal(mapped.selections[0].branch, "child");
  const nested = await f.sample({ type: "open", summary: "detail" }); await commitSpineTreeScopes(nested);
  await commitSpineTreeScopes(await f.sample({ type: "close", memory: "detail evidence" }));
  const close = await f.sample({ type: "close", memory: "v2 refined evidence" });
  const completed = await commitSpineTreeScopes(close);
  const state = await f.store.readSnapshot(completed.head);
  assert.equal(state.branches.child.status, "capped");
  assert.equal(state.branches.child.memoryVersion, 2);
  assert.equal(state.branches.child.reexecution.source.memory, "v1");
  assert.deepEqual(state.branches.child.reexecution.source.scopeBinding, oldScope);
  assert.equal(state.branches.child.reexecution.state, "completed");
  assert.equal(state.branches.child.memorySource.sessionId, "new-session");
  const replay = await commitSpineTreeScopes({ ...close, store: new GitSpineTreeStore(f.path) });
  assert.equal(replay.replayed, true); assert.equal(replay.head, completed.head);
  const final = await commitSpineTreeScopes(await f.sample());
  assert.equal((await f.store.readSnapshot(final.head)).branches.child.memoryVersion, 2);
  await f.registry.transition("new", "ended");
  const afterShutdown = await commitSpineTreeScopes({ ...close, store: new GitSpineTreeStore(f.path) }).catch(error => error);
  assert.equal(afterShutdown.code, "stale-commit", "older canonical receipt cannot roll back final continuation");
});

test("wrong lease cannot map reexecution; completed session cannot start a new task", async t => {
  const f = await fixture(t); const open = await f.sample({ type: "open", summary: "reexecute" });
  const head = await f.store.head();
  await assert.rejects(commitSpineTreeScopes({ ...open, binding: { ...open.binding, leaseId: "foreign" } }), { code: "binding-conflict" });
  assert.equal(await f.store.head(), head);
  await assert.rejects(commitSpineTreeScopes({ ...open, binding: undefined }), { code: "binding-conflict" });
  assert.equal(await f.store.head(), head);
  await commitSpineTreeScopes(open);
  const close = await f.sample({ type: "close", memory: "v2" });
  const beforeClose = await f.store.head();
  await assert.rejects(commitSpineTreeScopes({ ...close, alignment: undefined, binding: undefined, selections: [{ nodeId: open.projection.cursor, branch: "child" }] }), { code: "binding-conflict" });
  assert.equal(await f.store.head(), beforeClose);
  await assert.rejects(commitSpineTreeScopes({ ...close, alignment: undefined, binding: undefined, selections: [] }), { code: "binding-conflict" });
  assert.equal(await f.store.head(), beforeClose);
  await commitSpineTreeScopes(close);
  const extra = await f.sample({ type: "open", summary: "unrelated task" });
  const prior = await f.store.head();
  await assert.rejects(commitSpineTreeScopes(extra), { code: "binding-conflict" });
  assert.equal(await f.store.head(), prior);
});

test("parent terminal mappings survive two reexecutions without duplicate branches or stale memory writes", async t => {
  const temp = process.env.SPINETREE_TEST_TEMP ?? resolve("temp/null/20260926_2002/reexecution"); await mkdir(temp, { recursive: true });
  const path = await mkdtemp(join(temp, "retained-"));
  const store = GitSpineTreeStore.initialize(path, { branches: { root: { ...branch, id: "root", parent: null,
    status: "live", memory: null, memoryVersion: 0, memorySource: null, scopeBinding: undefined } }, schema: "spinetree.snapshot/v2" });
  const registry = new GitSpineTreeAgentRegistry(store);
  const parentBinding = { agentId: "parent", sessionId: "parent-session", branch: "root", status: "running",
    bindingId: "parent-binding", leaseId: "parent-lease", operationId: "parent-operation", epoch: 0, scopeCursor: [0] };
  await registry.registerWorkingExclusive(parentBinding);
  async function sampler(binding) {
    const runtime = createNodeSpineRuntime({ thread: binding.sessionId, features: ["jit", "spawn"] }); t.after(() => runtime.dispose());
    const controller = new SpineController(runtime.client, { async persist() {} }, { async publish() {} });
    await controller.observeSources([{ type: "message", boundary: 0, role: "user", content: "work" }]);
    let boundary = 0;
    return async operation => {
      await controller.beginSampling(); const key = `call-${++boundary}`;
      if (operation) await controller.registerExecution(key);
      await controller.observeSources([{ type: "message", boundary, role: "assistant", content: "iteration" }]);
      if (operation) { await controller.stageExecution(key, key, operation); await controller.finishExecution(key, true); }
      const commit = await controller.finishSampling({ terminal: "completed" });
      const updated = await registry.updateWorking(binding.agentId, binding.leaseId, { epoch: commit.record.record.epoch, scopeCursor: commit.projection.cursor });
      return { store, agentId: binding.agentId, sessionId: binding.sessionId, binding: updated,
        transactionId: commit.transactionId, record: commit.record.record, projection: commit.projection, alignment: "one-to-one" };
    };
  }
  const parent = await sampler(parentBinding);
  await commitSpineTreeScopes(await parent({ type: "open", summary: "work" }));
  const target = Object.values(store.readSnapshot(store.head()).branches).find(branch => branch.id !== "root").id;
  const closedReceipt = await parent({ type: "close", memory: "v1" });
  await commitSpineTreeScopes({ ...closedReceipt, alignment: undefined, selections: [] });
  const oldNodeId = closedReceipt.projection.nodes.find(node => node.kind === "Task").id;
  for (const version of [2, 3]) {
    const { binding } = await registry.rejuvenate({ parent: "root", branch: target }, { provision: context => ({
      agentId: `worker-${version}`, sessionId: `session-${version}`, branch: target, status: "running",
      bindingId: `binding-${version}`, leaseId: `lease-${version}`, operationId: context.executionId, epoch: 0, scopeCursor: [0],
    }) });
    // The parent commits while the successor owns the live branch.
    const concurrent = await parent(); await commitSpineTreeScopes(concurrent);
    assert.deepEqual(Object.keys(store.readSnapshot(store.head()).branches).sort(), ["root", target].sort());
    const invalid = structuredClone({ ...concurrent, store: undefined });
    const oldNode = invalid.projection.nodes.find(node => JSON.stringify(node.id) === JSON.stringify(oldNodeId));
    oldNode.status = "Live"; oldNode.memory = null;
    const next = await parent();
    const tampered = { ...next, projection: { ...next.projection,
      nodes: next.projection.nodes.map(node => JSON.stringify(node.id) === JSON.stringify(oldNode.id) ? oldNode : node) } };
    const head = store.head();
    await assert.rejects(commitSpineTreeScopes(tampered), { code: "binding-conflict" });
    assert.equal(store.head(), head);
    await commitSpineTreeScopes(next);
    const child = await sampler(binding);
    await commitSpineTreeScopes(await child({ type: "open", summary: "refine" }));
    await commitSpineTreeScopes(await child({ type: "close", memory: `v${version}` }));
    await registry.transition(binding.agentId, "ended");
    const before = store.readSnapshot(store.head()).branches[target];
    const continuation = { ...await parent(), alignment: undefined, selections: [{ nodeId: oldNodeId, branch: target }] }; await commitSpineTreeScopes(continuation);
    const after = store.readSnapshot(store.head());
    assert.deepEqual(after.branches[target], before, "old parent memory must not overwrite newer evidence");
    assert.equal(before.memoryVersion, version);
    assert.deepEqual(Object.keys(after.branches).sort(), ["root", target].sort());
    assert.equal((await commitSpineTreeScopes({ ...continuation, store: new GitSpineTreeStore(path) })).replayed, true);
  }
});

for (const omit of [false, true]) test(`result-level Next rejects atomically even when selector ${omit ? "omits" : "includes"} scopes`, async t => {
  const f = await fixture(t);
  await commitSpineTreeScopes(await f.sample({ type: "open", summary: "result" }));
  const next = await f.sample({ type: "next", closed_memory: "cannot treat Next as completion", next_summary: "second result" });
  const head = f.store.head();
  const before = f.store.readSnapshot(head);
  await assert.rejects(commitSpineTreeScopes({ ...next, ...(omit ? { alignment: undefined, selections: [] } : {}) }), { code: "binding-conflict" });
  assert.equal(f.store.head(), head);
  assert.deepEqual(f.store.readSnapshot(head), before);
});

test("second inline result rejects even when already terminal; nested Next remains valid", async t => {
  const f = await fixture(t);
  await commitSpineTreeScopes(await f.sample({ type: "open", summary: "result" }));
  await commitSpineTreeScopes(await f.sample({ type: "open", summary: "first detail" }));
  await commitSpineTreeScopes(await f.sample({ type: "next", closed_memory: "detail one", next_summary: "second detail" }));
  await commitSpineTreeScopes(await f.sample({ type: "close", memory: "detail two" }));
  await commitSpineTreeScopes(await f.sample({ type: "close", memory: "result v2" }));
  const extra = await f.sample({ type: "open", summary: "second result" });
  const closed = await f.sample({ type: "close", memory: "illegal second result" });
  // Validate the complete projection at a receipt boundary even if a selector
  // omits the extra Task. The installed first result remains untouched.
  const receipt = { ...extra, projection: { ...closed.projection, last_boundary: extra.record.post_boundary.ordinal }, alignment: undefined, selections: [] };
  const head = f.store.head();
  await assert.rejects(commitSpineTreeScopes(receipt), { code: "binding-conflict" });
  assert.equal(f.store.head(), head);
  assert.equal(f.store.readSnapshot(head).branches.child.memoryVersion, 2);
});
