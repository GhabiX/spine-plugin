import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { SpineController } from "@spinejit/pi-spinejit";
import { SpinePluginHost } from "@spinejit/spine-host";
import {
  commitSpineTreeScopes, createSpineTreePlugin, GitSpineTreeAgentRegistry, GitSpineTreeStore, MemorySpineTreeStore,
} from "../dist/index.js";

const root = { id: "root", parent: null, goal: "project", constraints: [], skills: [], tools: [], memory: null, memoryVersion: 0, memorySource: null, status: "live" };
const agent = { agentId: "a", sessionId: "pi-a", branch: "root", status: "running" };
const initial = () => ({ branches: { root }, schema: "spinetree.snapshot/v2", registry: { a: agent } });
const snapshot = store => store.readSnapshot(store.head());

async function canonical(t) {
  const runtime = createNodeSpineRuntime({ thread: "thread-a", features: ["jit", "spawn"] });
  t.after(() => runtime.dispose());
  const controller = new SpineController(runtime.client, { async persist() {} }, { async publish() {} });
  let boundary = 0;
  await controller.observeSources([{ type: "message", boundary, role: "user", content: "track selected work" }]);
  return async operation => {
    await controller.beginSampling();
    const key = `tool-${++boundary}`;
    if (operation) await controller.registerExecution(key);
    await controller.observeSources([{ type: "message", boundary, role: "assistant", content: operation?.type ?? "continue" }]);
    if (operation) {
      await controller.stageExecution(key, key, operation);
      await controller.finishExecution(key, true);
    }
    const result = await controller.finishSampling({ terminal: "completed" });
    assert.equal(result.type, "committed");
    return { agentId: "a", sessionId: "pi-a", transactionId: result.transactionId, record: result.record.record, projection: result.projection };
  };
}

async function readHost(t, store) {
  const host = new SpinePluginHost();
  host.register({ manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} });
  host.register(createSpineTreePlugin({ store }));
  await host.activateAll();
  t.after(() => host.dispose());
  return branch => host.executeTool("spinetree_read", { branch });
}

test("real canonical open/next/close persists selected branches, exact memory and provenance in Git", async t => {
  const commit = await canonical(t);
  const path = await mkdtemp(join(tmpdir(), "spinetree-scopes-"));
  const store = GitSpineTreeStore.initialize(path, initial());
  const opened = await commit({ type: "open", summary: "first" });
  const first = await commitSpineTreeScopes({ store, ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] });
  const id = first.selections[0].branch;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notEqual(id, opened.projection.cursor.join("."));
  const read = await readHost(t, store);
  assert.deepEqual((await read(id)).binding, agent);
  assert.equal((await read(id)).branch.status, "live");
  const next = await commit({ type: "next", closed_memory: "first evidence", next_summary: "second" });
  const second = await commitSpineTreeScopes({ store, ...next, selections: [{ nodeId: next.projection.cursor, parent: "root" }] });
  const capped = (await read(id)).branch;
  const terminal = next.projection.nodes.find(node => JSON.stringify(node.id) === JSON.stringify(opened.projection.cursor));
  assert.deepEqual(capped.memory, terminal.memory);
  assert.equal(capped.status, "capped");
  assert.equal(capped.memoryVersion, 1);
  assert.deepEqual(capped.memorySource, {
    ...capped.scopeBinding, schema: "spinetree.scope.memory/v1", transactionId: next.transactionId,
    commitId: next.record.commit_id, postBoundary: next.record.post_boundary,
  });
  assert.equal((await read(id)).binding, null);
  assert.deepEqual((await read(second.selections[0].branch)).binding, agent);
  const closed = await commit({ type: "close", memory: "second evidence" });
  await commitSpineTreeScopes({ store, ...closed, selections: [] });
  assert.equal((await read(second.selections[0].branch)).branch.status, "capped");
  assert.deepEqual((await read(id)).branch, capped);
  assert.equal(snapshot(store).registry.a.status, "running");
  const reloaded = new GitSpineTreeStore(path);
  assert.deepEqual(snapshot(reloaded), snapshot(store));
  assert.equal(store.readSnapshot(first.head).branches[id].status, "live");
});

test("unselected scopes stay local; existing branch mapping preserves project attributes", async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore({ ...initial(), branches: { root, work: { ...root, id: "work", parent: "root" } } });
  const hidden = await commit({ type: "open", summary: "local" });
  await commitSpineTreeScopes({ store, ...hidden, selections: [] });
  assert.deepEqual(Object.keys(snapshot(store).branches), ["root", "work"]);
  const child = await commit({ type: "open", summary: "tracked" });
  const result = await commitSpineTreeScopes({ store, ...child, selections: [{ nodeId: child.projection.cursor, branch: "work" }] });
  assert.equal(result.selections[0].branch, "work");
  assert.equal(snapshot(store).branches.root.goal, "project");
  const closed = await commit({ type: "close", memory: "with evidence" });
  await commitSpineTreeScopes({ store, ...closed, selections: [] });
  assert.equal(snapshot(store).branches.work.status, "capped");
});

for (const fullBinding of [false, true]) test(`selector cannot rebind capped work without typed reexecution (${fullBinding ? "working" : "basic"} binding)`, async t => {
  const commit = await canonical(t);
  const working = { ...agent, bindingId: "binding-a", leaseId: "lease-a", operationId: "operation-a", epoch: 0, scopeCursor: [0] };
  const store = new MemorySpineTreeStore({ ...initial(),
    branches: { root, work: { ...root, id: "work", parent: "root" } },
    registry: { a: fullBinding ? working : agent },
  });
  const sample = async operation => {
    const receipt = await commit(operation);
    const binding = fullBinding ? await new GitSpineTreeAgentRegistry(store).updateWorking("a", "lease-a", {
      epoch: receipt.record.epoch, scopeCursor: receipt.projection.cursor,
    }) : undefined;
    return { store, ...receipt, ...(binding === undefined ? {} : { binding }) };
  };
  const first = await sample({ type: "open", summary: "first result" });
  await commitSpineTreeScopes({ ...first, selections: [{ nodeId: first.projection.cursor, branch: "work" }] });
  await commitSpineTreeScopes({ ...await sample({ type: "close", memory: "v1" }), selections: [] });
  const second = await sample({ type: "open", summary: "unleased replacement" });
  const before = snapshot(store);
  const head = store.head();
  assert.equal(before.branches.work.memoryVersion, 1);
  await assert.rejects(commitSpineTreeScopes({ ...second, selections: [{ nodeId: second.projection.cursor, branch: "work" }] }), { code: "binding-conflict" });
  assert.equal(store.head(), head);
  assert.deepEqual(snapshot(store), before);
});

test("receipt replay is write-free after reload; changed selections and stale receipts fail", async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const opened = await commit({ type: "open", summary: "work" });
  const receipt = { store, ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] };
  const first = await commitSpineTreeScopes(receipt);
  const replayed = await commitSpineTreeScopes(receipt);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.head, first.head);
  assert.deepEqual(replayed.selections, first.selections);
  const reordered = {
    selections: receipt.selections.map(({ nodeId, parent }) => ({ parent, nodeId })),
    projection: opened.projection,
    record: { ...opened.record, commit_id: { value: opened.record.commit_id.value, thread: opened.record.commit_id.thread } },
    transactionId: opened.transactionId, sessionId: opened.sessionId, agentId: opened.agentId, store,
  };
  assert.equal((await commitSpineTreeScopes(reordered)).replayed, true);
  await assert.rejects(commitSpineTreeScopes({ ...receipt, selections: [] }), { code: "conflicting-replay" });
  const closed = await commit({ type: "close", memory: "done" });
  await commitSpineTreeScopes({ store, ...closed, selections: [] });
  const head = store.head();
  await assert.rejects(commitSpineTreeScopes(receipt), { code: "stale-commit" });
  assert.equal(store.head(), head);
});

test("historical receipt replay stays write-free after Agent/session reattachment; forged binding is rejected", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "reattach" });
  const working = {
    agentId: "a", sessionId: "pi-a", branch: "root", status: "running",
    bindingId: "binding-a", leaseId: "lease-a", operationId: "operation-a",
    epoch: opened.record.epoch, scopeCursor: [...opened.projection.cursor],
  };
  const store = new MemorySpineTreeStore({ branches: { root }, schema: "spinetree.snapshot/v2", registry: { a: working } });
  const receipt = { store, ...opened, binding: working, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] };
  const first = await commitSpineTreeScopes(receipt);
  const rebound = snapshot(store);
  rebound.registry = {
    b: { ...working, agentId: "b", sessionId: "pi-b", bindingId: "binding-b", leaseId: "lease-b" },
  };
  const reboundCommit = await store.commitSnapshot(store.head(), rebound, "test: reattach Agent");
  const replayed = await commitSpineTreeScopes(receipt);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.head, reboundCommit.head);
  const forged = { ...receipt, binding: { ...working, bindingId: "forged-binding", leaseId: "forged-lease" } };
  await assert.rejects(commitSpineTreeScopes(forged), { code: "conflicting-replay" });
  assert.equal(store.head(), reboundCommit.head);
});

test("one-to-one alignment reuses generated UUIDs and resolves nested parents in one batch", async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const opened = await commit({ type: "open", summary: "parent" });
  const parent = opened.projection.nodes.find(node => node.kind === "Task");
  assert.ok(parent);
  const child = {
    ...parent, id: [...parent.id, 1], parent: [...parent.id], children: [], summary: "child",
  };
  const aligned = {
    ...opened,
    alignment: "one-to-one",
    projection: {
      ...opened.projection,
      cursor: child.id,
      nodes: [...opened.projection.nodes, child],
    },
  };
  const first = await commitSpineTreeScopes({ store, ...aligned });
  assert.equal(first.selections.length, 2);
  const parentBranch = first.selections.find(selection => JSON.stringify(selection.nodeId) === JSON.stringify(parent.id)).branch;
  const childBranch = first.selections.find(selection => JSON.stringify(selection.nodeId) === JSON.stringify(child.id)).branch;
  assert.notEqual(parentBranch, "root");
  assert.equal(snapshot(store).branches[parentBranch].parent, "root");
  assert.equal(snapshot(store).branches[childBranch].parent, parentBranch);
  const head = store.head();
  const replayed = await commitSpineTreeScopes({ store, ...aligned });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.head, head);
  assert.deepEqual(replayed.selections, first.selections);
});

test("reselecting an archived terminal mapping preserves its result after an omitted selection", async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const opened = await commit({ type: "open", summary: "work" });
  const selections = [{ nodeId: opened.projection.cursor, parent: "root" }];
  const imported = await commitSpineTreeScopes({ store, ...opened, selections });
  const closed = await commit({ type: "close", memory: "done" });
  await commitSpineTreeScopes({ store, ...closed, selections: [] });
  store.change(store.head(), [{ type: "archive", branch: imported.selections[0].branch }]);
  const archived = snapshot(store).branches[imported.selections[0].branch];
  const next = { store, ...await commit(), selections };
  const continued = await commitSpineTreeScopes(next);
  assert.deepEqual(continued.selections, imported.selections);
  assert.deepEqual(snapshot(store).branches[archived.id], archived);
  const head = store.head();
  assert.equal((await commitSpineTreeScopes(next)).head, head);
});

for (const home of ["root", "work"]) test(`capped mapping can rejuvenate and rebind while respecting Agent home ${home}`, async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore({
    branches: { root, work: { ...root, id: "work", parent: "root", goal: "durable goal" } }, schema: "spinetree.snapshot/v2",
    registry: { a: agent },
  });
  const opened = await commit({ type: "open", summary: "first scope" });
  await commitSpineTreeScopes({ store, ...opened, selections: [{ nodeId: opened.projection.cursor, branch: "work" }] });
  await commitSpineTreeScopes({ store, ...await commit({ type: "close", memory: "first memory" }), selections: [] });
  const registry = new GitSpineTreeAgentRegistry(store);
  let replacement = { agentId: "b", sessionId: "pi-b", branch: "work", status: "running", bindingId: "binding-b", leaseId: "lease-b", operationId: "pending", epoch: 0, scopeCursor: [0] };
  const host = new SpinePluginHost();
  host.register({ manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} });
  host.register(createSpineTreePlugin({ store, registry, rejuvenator: { async provision(context) {
    assert.deepEqual(context.branch.memory, snapshot(store).branches.work.memory);
    replacement = { ...replacement, operationId: context.executionId };
    return replacement;
  } } }));
  await host.activateAll();
  t.after(() => host.dispose());
  if (home === "work") {
    const occupied = snapshot(store);
    occupied.registry.a.branch = "work";
    await store.commitSnapshot(store.head(), occupied, "test: assignment occupies capped history");
    await assert.rejects(host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "work" }), { code: "branch-occupied" });
    await assert.rejects(registry.registerExclusive(replacement), { code: "branch-occupied" });
    await registry.transition("a", "ended");
  }
  assert.deepEqual((await host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "work" })).binding, replacement);
  assert.deepEqual((await host.executeTool("spinetree_read", { branch: "work" })).binding, replacement);
  const secondCommit = await canonical(t);
  const reopened = await secondCommit({ type: "open", summary: "replacement scope" });
  replacement = await registry.updateWorking("b", "lease-b", { epoch: reopened.record.epoch, scopeCursor: reopened.projection.cursor });
  await commitSpineTreeScopes({ store, ...reopened, agentId: "b", sessionId: "pi-b", binding: replacement, selections: [{ nodeId: reopened.projection.cursor, branch: "work" }] });
  assert.deepEqual((await host.executeTool("spinetree_read", { branch: "work" })).binding, replacement);
  const finished = await secondCommit({ type: "close", memory: "replacement memory" });
  replacement = await registry.updateWorking("b", "lease-b", { epoch: finished.record.epoch, scopeCursor: finished.projection.cursor });
  await commitSpineTreeScopes({ store, ...finished, agentId: "b", sessionId: "pi-b", binding: replacement, selections: [] });
  const branch = snapshot(store).branches.work;
  assert.equal(branch.goal, "durable goal");
  assert.equal(branch.memoryVersion, 2);
  assert.equal(branch.memorySource.agentId, "b");
  assert.equal((await registry.resolve("a")).status, home === "work" ? "ended" : "running");
  assert.deepEqual(branch.memory, finished.projection.nodes.find(node => node.kind === "Task").memory);
});

test("bad mappings are atomic and do not steal active branches", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "work" });
  const store = new MemorySpineTreeStore({ ...initial(), registry: { a: agent, b: { ...agent, agentId: "b", sessionId: "pi-b" } } });
  const head = store.head();
  const nodeId = opened.projection.cursor;
  for (const selections of [
    [{ nodeId, parent: "root" }, { nodeId: [99], parent: "root" }],
    [{ nodeId: [1], parent: "root" }], [{ nodeId, parent: "missing" }],
    [{ nodeId, branch: "root" }], [{ nodeId, parent: "root", branch: "root" }],
  ]) await assert.rejects(commitSpineTreeScopes({ store, ...opened, selections }));
  assert.equal(store.head(), head);
  assert.deepEqual(Object.keys(snapshot(store).branches), ["root"]);
  await assert.rejects(commitSpineTreeScopes({ store, ...opened, agentId: "missing", selections: [] }), { code: "unknown-agent" });
});

test("CAS races replay the draft against fresh state; persistence failure preserves a retryable receipt", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "work" });
  const store = new MemorySpineTreeStore(initial());
  let raced = false;
  const racing = {
    head: () => store.head(), readSnapshot: head => store.readSnapshot(head),
    commitSnapshot(head, draft, message) {
      if (!raced) { raced = true; store.change(head, [{ type: "update", branch: "root", attributes: { goal: "concurrent goal" } }]); }
      return store.commitSnapshot(head, draft, message);
    },
  };
  const receipt = { ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] };
  const result = await commitSpineTreeScopes({ store: racing, ...receipt });
  assert.equal(snapshot(store).branches.root.goal, "concurrent goal");
  assert.equal(Object.keys(snapshot(store).branches).length, 2);
  assert.equal(snapshot(store).branches[result.selections[0].branch].goal, "work");
  const secondStore = new MemorySpineTreeStore(initial());
  const head = secondStore.head();
  const fault = new Error("disk write failed");
  await assert.rejects(commitSpineTreeScopes({ ...receipt, store: {
    head: () => secondStore.head(), readSnapshot: h => secondStore.readSnapshot(h), commitSnapshot() { throw fault; },
  } }), error => error === fault);
  assert.equal(secondStore.head(), head);
  await commitSpineTreeScopes({ store: secondStore, ...receipt });
  assert.equal(Object.keys(snapshot(secondStore).branches).length, 2);
});

test("concurrent import of the same receipt converges to one UUID and one project write", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "work" });
  const store = new MemorySpineTreeStore(initial());
  const receipt = { store, ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] };
  const results = await Promise.all([commitSpineTreeScopes(receipt), commitSpineTreeScopes(receipt)]);
  assert.deepEqual(results[0].selections, results[1].selections);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(Object.keys(snapshot(store).branches).length, 2);
});

test("missing live scopes, epoch migration and skipped commits fail without guessing memory", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "work" });
  const store = new MemorySpineTreeStore(initial());
  await commitSpineTreeScopes({ store, ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] });
  const next = await commit();
  const head = store.head();
  await assert.rejects(commitSpineTreeScopes({ store, ...next, projection: { ...next.projection, nodes: [] }, selections: [] }), { code: "unsupported-scope" });
  const changedEpoch = structuredClone(next);
  changedEpoch.record.epoch += 1;
  changedEpoch.record.pre_boundary.epoch += 1;
  changedEpoch.record.post_boundary.epoch += 1;
  await assert.rejects(commitSpineTreeScopes({ store, ...changedEpoch, selections: [] }), { code: "unsupported-scope" });
  const later = await commit();
  await assert.rejects(commitSpineTreeScopes({ store, ...later, selections: [] }), { code: "stale-commit" });
  assert.equal(store.head(), head);
});

test("mapped live ownership blocks exclusive registration, while capped history permits a new owner", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "work" });
  const store = new MemorySpineTreeStore(initial());
  const registry = new GitSpineTreeAgentRegistry(store);
  const mapped = await commitSpineTreeScopes({ store, ...opened, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] });
  const id = mapped.selections[0].branch;
  const newAgent = { ...agent, agentId: "b", sessionId: "pi-b", branch: id };
  await assert.rejects(registry.registerExclusive(newAgent), { code: "branch-occupied" });
  const closed = await commit({ type: "close", memory: "cap" });
  await commitSpineTreeScopes({ store, ...closed, selections: [] });
  await registry.registerExclusive(newAgent);
  const read = await readHost(t, store);
  assert.equal((await read(id)).binding, null);
  assert.equal((await registry.resolve("a")).status, "running");
});

test("first Open creates a child; Close preserves identity and local resources without cloning home", async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "home scope" });
  const working = {
    agentId: "a", sessionId: "pi-a", branch: "root", status: "running",
    bindingId: "binding-a", leaseId: "lease-a", operationId: "operation-a",
    epoch: opened.record.epoch, scopeCursor: [...opened.projection.cursor],
  };
  const store = new MemorySpineTreeStore({ branches: { root: { ...root, constraints: ["root constraint"], skills: [{ name: "method", version: "v1" }], tools: [{ name: "reader", version: "v1" }] } }, schema: "spinetree.snapshot/v2", registry: { a: working } });
  const registry = new GitSpineTreeAgentRegistry(store);
  const openedReceipt = { store, ...opened, binding: working, selections: [{ nodeId: opened.projection.cursor, parent: "root" }] };
  const first = await commitSpineTreeScopes(openedReceipt);
  const id = first.selections[0].branch;
  const before = snapshot(store);
  assert.notEqual(id, "root");
  assert.equal(before.branches[id].parent, "root");
  assert.equal(before.branches.root.scopeBinding, undefined);
  assert.deepEqual(before.branches[id].constraints, []);
  assert.deepEqual(before.branches[id].skills, []);
  assert.deepEqual(before.branches[id].tools, []);
  const closed = await commit({ type: "close", memory: "home evidence" });
  const closedBinding = { ...working, epoch: closed.record.epoch, scopeCursor: [...closed.projection.cursor] };
  await registry.updateWorking("a", working.leaseId, closedBinding);
  await commitSpineTreeScopes({ store, ...closed, binding: closedBinding, selections: [] });
  const current = snapshot(store);
  assert.equal(current.branches.root.status, "live");
  const capped = Object.values(current.branches).find(branch => branch.id !== "root" && branch.status === "capped");
  assert.ok(capped);
  assert.equal(capped.id, id);
  assert.deepEqual(capped.scopeBinding, before.branches[id].scopeBinding);
  assert.deepEqual(Object.keys(current.branches), Object.keys(before.branches));
  assert.equal(current.registry.a.branch, "root");
  assert.deepEqual(current.branches.root, before.branches.root);
  assert.equal(capped.parent, "root");
  assert.match(JSON.stringify(capped.memory), /home evidence/);
});

for (const full of [false, true]) test(`ordinary home mapping rejects with ${full ? "complete" : "basic"} binding; import admission checks the complete lease`, async t => {
  const commit = await canonical(t);
  const opened = await commit({ type: "open", summary: "owned work" });
  const binding = full ? { ...agent, bindingId: "binding", leaseId: "lease", operationId: "operation", epoch: opened.record.epoch, scopeCursor: opened.projection.cursor }
    : { ...agent, bindingId: "basic-binding-is-not-a-working-lease" };
  const store = new MemorySpineTreeStore({ ...initial(), registry: { a: binding } });
  const head = store.head();
  const receipt = { store, ...opened, ...(full ? { binding } : {}), selections: [{ nodeId: opened.projection.cursor, branch: "root" }] };
  await assert.rejects(commitSpineTreeScopes(receipt), { code: "binding-conflict" });
  assert.equal(store.head(), head);
  const aligned = { ...receipt, selections: [], alignment: "one-to-one" };
  if (full) {
    await assert.rejects(commitSpineTreeScopes({ ...aligned, binding: undefined }), { code: "binding-conflict" });
    assert.equal(store.head(), head);
  }
  const result = await commitSpineTreeScopes(aligned);
  assert.equal(snapshot(store).branches[result.selections[0].branch].parent, "root");
});

test("inline Next makes one sibling and Close preserves both committed mappings", async t => {
  const commit = await canonical(t);
  const store = new MemorySpineTreeStore(initial());
  const opened = await commit({ type: "open", summary: "first" });
  const first = await commitSpineTreeScopes({ store, ...opened, alignment: "one-to-one" });
  const firstId = first.selections[0].branch;
  const original = snapshot(store).branches[firstId];
  const next = await commit({ type: "next", closed_memory: "first done", next_summary: "second" });
  const second = await commitSpineTreeScopes({ store, ...next, alignment: "one-to-one" });
  const secondId = second.selections.find(item => JSON.stringify(item.nodeId) === JSON.stringify(next.projection.cursor)).branch;
  const mid = snapshot(store);
  assert.equal(Object.keys(mid.branches).length, 3);
  assert.equal(mid.branches[secondId].parent, original.parent);
  assert.deepEqual(mid.branches[firstId].scopeBinding, original.scopeBinding);
  assert.equal(mid.branches[firstId].memoryVersion, 1);
  await commitSpineTreeScopes({ store, ...await commit({ type: "close", memory: "second done" }), selections: [] });
  const final = snapshot(store);
  assert.deepEqual(Object.keys(final.branches), Object.keys(mid.branches));
  assert.equal(final.branches[secondId].status, "capped");
  assert.deepEqual(final.branches[firstId], mid.branches[firstId]);
  assert.deepEqual(final.scopeImports[JSON.stringify(["pi-a", "thread-a"])].mappings, second.selections);
});
