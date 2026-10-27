import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { SpineController } from "@spinejit/pi-spinejit";
import { commitSpineTreeScopes, GitSpineTreeAgentRegistry, MemorySpineTreeStore } from "../dist/index.js";

const project = (id, parent = null) => ({ id, parent, goal: id, constraints: [], skills: [], tools: [], memory: null, memoryVersion: 0, memorySource: null, status: "live" });
const read = store => store.readSnapshot(store.head());
const working = (agentId, branch) => ({
  agentId, sessionId: `session-${agentId}`, branch, status: "running", bindingId: `binding-${agentId}`,
  leaseId: `lease-${agentId}`, operationId: `operation-${agentId}`, epoch: 0, scopeCursor: [1],
});
async function canonical(t, binding, store, parent) {
  const runtime = createNodeSpineRuntime({ thread: parent?.thread ?? binding.sessionId, features: ["jit", "spawn"] });
  t.after(() => runtime.dispose());
  const replay = parent === undefined ? [] : structuredClone(parent.replay);
  const controller = new SpineController(runtime.client, { async persist({ record }) { replay.push({ type: "archive", record: structuredClone(record) }); } }, { async publish() {} });
  let boundary = -1;
  if (parent !== undefined) {
    await controller.replay(replay);
    const source = await controller.continueNamespace(binding.sessionId);
    boundary = Math.max(...source.cells.map(cell => cell.boundary));
  }
  async function observe(character) {
    replay.push({ type: "source", character: structuredClone(character) });
    await controller.observeSources([character]);
  }
  await observe({ type: "message", boundary: ++boundary, role: "user", content: "bounded ownership work" });
  const commit = async operations => {
    await controller.beginSampling();
    for (const [batchId, operation] of operations) {
      await controller.registerExecution(batchId);
      await observe({ type: "message", boundary: ++boundary, role: "assistant", content: operation.type });
      await controller.stageExecution(batchId, batchId, operation);
      await controller.finishExecution(batchId, true);
    }
    if (operations.length === 0) await observe({ type: "message", boundary: ++boundary, role: "assistant", content: "continue" });
    const result = await controller.finishSampling({ terminal: "completed" });
    assert.equal(result.type, "committed");
    const registry = new GitSpineTreeAgentRegistry(store);
    const current = await registry.updateWorking(binding.agentId, binding.leaseId, { epoch: result.record.record.epoch, scopeCursor: result.projection.cursor });
    const { bindingId, leaseId, agentId, sessionId, branch, epoch, scopeCursor } = current;
    return { agentId, sessionId, transactionId: result.transactionId, record: result.record.record, projection: result.projection,
      binding: { bindingId, leaseId, agentId, sessionId, branch, epoch, scopeCursor } };
  };
  return Object.assign(commit, { replay, thread: binding.sessionId });
}

async function fixture(t, options = {}) {
  let parent = working("parent", options.reexecution ? "assignment" : "root");
  const store = new MemorySpineTreeStore({ schema: "spinetree.snapshot/v2", branches: { root: project("root") }, registry: options.reexecution ? {} : { parent } });
  if (options.reexecution) {
    const snapshot = read(store);
    snapshot.branches.assignment = { ...project("assignment", "root"), status: "capped", memory: "v1", memoryVersion: 1 };
    store.commitSnapshot(store.head(), snapshot, "test: completed assignment");
    ({ binding: parent } = await new GitSpineTreeAgentRegistry(store).rejuvenate({ parent: "root", branch: "assignment" }, {
      provision: context => ({ ...parent, operationId: context.executionId }),
    }));
  }
  const commit = await canonical(t, parent, store);
  const opened = await commit(options.rootFloor ? [] : [["open", { type: "open", summary: "parent" }]]);
  const first = await commitSpineTreeScopes({ store, ...opened, alignment: "one-to-one" });
  let launchParent = options.rootFloor ? parent.branch : first.selections[0].branch;
  if (options.nested) {
    const nested = await commit([["open-nested", { type: "open", summary: "nested committed owner" }]]);
    const imported = await commitSpineTreeScopes({ store, ...nested, alignment: "one-to-one" });
    launchParent = imported.selections.find(selection => JSON.stringify(selection.nodeId) === JSON.stringify(nested.projection.cursor)).branch;
  }
  const task = { summary: "same bounded task", prompt: "separate owned output" };
  const batchId = "spawn-batch";
  const tasks = [task, task]; // Identical tasks require ordinal and execution identity, not prose matching.
  const terminal_results = [];
  const children = [];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const id = `child-${ordinal}`;
    const child = working(id, id);
    const snapshot = read(store);
    snapshot.branches[id] = { ...project(id, launchParent), spawnReservation: {
      schema: "spinetree.spawn.reservation/v1", state: "launched", batchId, ordinal, attempt: 0,
      ownerToken: `owner-${ordinal}`, parentAgentId: parent.agentId, parentBindingId: parent.bindingId,
      parentBranch: launchParent,
      parentScope: { sessionId: parent.sessionId, thread: parent.sessionId, epoch: 0, nodeId: [...snapshot.registry.parent.scopeCursor] },
      sessionId: child.sessionId, task, agentId: id, launchId: `${batchId}:${ordinal}:attempt-0`, outcome: null, activation: null,
    } };
    snapshot.registry[id] = child;
    await store.commitSnapshot(store.head(), snapshot, "test: launch child");
    const childCommit = await canonical(t, child, store, commit);
    children.push(childCommit);
    const childOpened = await childCommit([["child-open", { type: "open", summary: "real child sampling" }]]);
    await commitSpineTreeScopes({ store, ...childOpened, alignment: "one-to-one" });
    if (options.rootFloor) {
      assert.equal(read(store).branches[id].scopeBinding, undefined);
      assert.equal(Object.values(read(store).branches).filter(branch => branch.parent === id && branch.scopeBinding?.agentId === id).length, 1);
    } else assert.equal(read(store).branches[id].scopeBinding.agentId, id);
    await new GitSpineTreeAgentRegistry(store).transition(id, "ended");
    terminal_results.push({ ordinal, outcome: "completed", memory_body: `evidence ${ordinal}`, execution_ref: `${batchId}:${ordinal}:attempt-0:${child.sessionId}` });
  }
  const receipt = await commit([[batchId, { type: "spawn", tasks, terminal_results }]]);
  const selections = receipt.projection.nodes.flatMap(node => {
    const item = node.memory?.find(slot => slot.SpawnEvidence)?.SpawnEvidence;
    if (!item) return [];
    return [{ nodeId: node.id, branch: terminal_results.find(result => result.execution_ref === item.execution_ref).ordinal === 0 ? "child-0" : "child-1" }];
  });
  return { store, commit, children, receipt: { ...receipt, alignment: "one-to-one", selections } };
}

test("real child sampling imports hand off atomically; replay is write-free and parent continues", async t => {
  const { store, commit, receipt } = await fixture(t);
  const before = read(store);
  const head = store.head();
  const first = await commitSpineTreeScopes({ store, ...receipt });
  assert.notEqual(first.head, head);
  const after = read(store);
  for (const id of ["child-0", "child-1"]) {
    const branch = after.branches[id];
    assert.equal(branch.status, "capped");
    assert.equal(branch.memoryVersion, 1);
    assert.equal(branch.spawnReservation.state, "terminal");
    assert.equal(branch.spawnReservation.outcome, "completed");
    assert.deepEqual(branch.spawnReservation.handoff.from.scopeBinding, before.branches[id].scopeBinding);
    assert.deepEqual(branch.spawnReservation.handoff.from.binding, before.registry[id]);
    assert.deepEqual(branch.spawnReservation.handoff.commitId, receipt.record.commit_id);
    assert.equal(branch.scopeBinding.agentId, "parent");
    assert.equal(branch.memorySource.sessionId, "session-parent");
  }
  assert.equal(after.scopeImports[JSON.stringify(["session-parent", "session-parent"])].commitId, receipt.record.commit_id.value);
  const replay = await commitSpineTreeScopes({ store, ...receipt });
  assert.equal(replay.replayed, true);
  assert.equal(replay.head, first.head);
  const journalReplay = await commitSpineTreeScopes({ store, ...receipt, selections: first.selections });
  assert.equal(journalReplay.replayed, true);
  assert.equal(journalReplay.head, first.head);
  await assert.rejects(commitSpineTreeScopes({ store, ...receipt, selections: [{ ...first.selections[0], branch: "different" }] }), { code: "conflicting-replay" });
  const continued = await commit([]);
  await commitSpineTreeScopes({ store, ...continued, alignment: "one-to-one" });
  for (const id of ["child-0", "child-1"]) assert.deepEqual(read(store).branches[id], after.branches[id]);
});

test("nested Open then Spawn preserves all alignment and the committed parent", async t => {
  const { store, receipt } = await fixture(t, { nested: true });
  const imported = await commitSpineTreeScopes({ store, ...receipt });
  const parentId = imported.selections.find(selection => JSON.stringify(selection.nodeId) === JSON.stringify(receipt.projection.cursor)).branch;
  assert.notEqual(parentId, "root");
  assert.notEqual(read(store).branches[parentId].parent, "root");
  assert.equal(read(store).branches[read(store).branches[parentId].parent].parent, "root");
  for (const id of ["child-0", "child-1"]) {
    assert.equal(read(store).branches[id].parent, parentId);
    assert.equal(read(store).branches[id].spawnReservation.parentBranch, parentId);
    assert.equal(read(store).branches[id].spawnReservation.handoff.to.parent, parentId);
  }
});

const invalidCases = {
  "active child": s => { s.registry["child-1"].status = "running"; },
  "wrong parent binding": s => { s.branches["child-1"].spawnReservation.parentBindingId = "different"; },
  "wrong parent Scope": s => { s.branches["child-1"].spawnReservation.parentScope.nodeId = [1]; },
  "mismatched batch": s => { Object.assign(s.branches["child-1"].spawnReservation, { batchId: "different", launchId: "different:1:attempt-0" }); },
  "wrong ordinal": s => { Object.assign(s.branches["child-1"].spawnReservation, { ordinal: 0, launchId: "spawn-batch:0:attempt-0" }); },
  "wrong child agent": s => { s.branches["child-1"].spawnReservation.agentId = "child-0"; },
  "wrong child session": s => { s.registry["child-1"].sessionId = "different"; },
  "wrong reserved child session": s => { s.branches["child-1"].spawnReservation.sessionId = "different"; },
  "wrong scope owner": s => { s.branches["child-1"].scopeBinding.agentId = "intruder"; },
  "wrong scope thread": s => { s.branches["child-1"].scopeBinding.thread = "intruder"; },
  "different terminal outcome": s => { Object.assign(s.branches["child-1"].spawnReservation, { state: "terminal", outcome: "errored" }); },
};
for (const [name, mutate] of Object.entries(invalidCases)) test(`reject ${name} without partially importing another child`, async t => {
  const { store, receipt } = await fixture(t);
  const changed = read(store);
  mutate(changed);
  await store.commitSnapshot(store.head(), changed, "test: conflict");
  const before = read(store);
  const head = store.head();
  await assert.rejects(commitSpineTreeScopes({ store, ...receipt }), { code: "binding-conflict" });
  assert.equal(store.head(), head);
  assert.deepEqual(read(store), before);
});

for (const mode of ["missing overrides", "new child", "unreserved branch"]) for (const active of [false, true]) {
  test(`ordinary Spawn cannot bypass its reservation using ${mode} (${active ? "running" : "ended"} child)`, async t => {
    const { store, receipt } = await fixture(t);
    const changed = read(store);
    if (active) changed.registry["child-0"].status = "running";
    if (mode === "unreserved branch") changed.branches.other = project("other", changed.branches["child-0"].parent);
    store.commitSnapshot(store.head(), changed, "test: handoff preconditions");
    const before = read(store);
    const head = store.head();
    const selection = receipt.selections.find(item => item.branch === "child-0");
    const invalid = mode === "missing overrides" ? { ...receipt, selections: [] } : {
      ...receipt, alignment: undefined, selections: [{ nodeId: selection.nodeId,
        ...(mode === "new child" ? { parent: before.branches["child-0"].parent } : { branch: "other" }),
      }],
    };
    await assert.rejects(commitSpineTreeScopes({ store, ...invalid }), { code: "binding-conflict" });
    assert.equal(store.head(), head);
    assert.deepEqual(read(store), before);
  });
}

test("ordinary live binding remains protected without Spawn authority", async t => {
  const { store, receipt } = await fixture(t);
  const forged = structuredClone(receipt);
  forged.record.executions = [];
  await assert.rejects(commitSpineTreeScopes({ store, ...forged }), { code: "binding-conflict" });
  assert.equal(read(store).branches["child-0"].scopeBinding.agentId, "child-0");
});

test("failed CAS publishes no handoff, memory or watermark; the same receipt remains usable", async t => {
  const { store, receipt } = await fixture(t);
  const before = read(store);
  const head = store.head();
  const failing = {
    head: () => store.head(), readSnapshot: ref => store.readSnapshot(ref),
    commitSnapshot() { throw new Error("injected commit failure"); },
  };
  await assert.rejects(commitSpineTreeScopes({ store: failing, ...receipt }), /injected commit failure/);
  assert.equal(store.head(), head);
  assert.deepEqual(read(store), before);
  assert.equal((await commitSpineTreeScopes({ store, ...receipt })).replayed, false);
});

for (const active of [false, true]) test(`CAS retry rechecks child ownership after concurrent ${active ? "activation" : "unrelated update"}`, async t => {
  const { store, receipt } = await fixture(t);
  const before = read(store);
  let attempts = 0;
  const racing = {
    head: () => store.head(), readSnapshot: ref => store.readSnapshot(ref),
    commitSnapshot(expected, next, message) {
      if (attempts++ === 0) {
        const concurrent = read(store);
        concurrent.branches.root.goal = "concurrent change survives";
        if (active) concurrent.registry["child-1"].status = "running";
        store.commitSnapshot(store.head(), concurrent, "test: concurrent mutation");
      }
      return store.commitSnapshot(expected, next, message);
    },
  };
  if (active) {
    await assert.rejects(commitSpineTreeScopes({ store: racing, ...receipt }), { code: "binding-conflict" });
    assert.equal(attempts, 1);
    const after = read(store);
    assert.deepEqual(after.branches["child-0"], before.branches["child-0"]);
    assert.deepEqual(after.branches["child-1"], before.branches["child-1"]);
    assert.deepEqual(after.scopeImports, before.scopeImports);
  } else {
    const result = await commitSpineTreeScopes({ store: racing, ...receipt });
    assert.equal(result.replayed, false);
    assert.equal(attempts, 2);
    for (const id of ["child-0", "child-1"]) assert.equal(read(store).branches[id].memoryVersion, 1);
  }
  assert.equal(read(store).branches.root.goal, "concurrent change survives");
});

test("reexecution RootEpoch Spawn terminals keep reservations, then one inline result and nested work update the assignment", async t => {
  const { store, commit, receipt } = await fixture(t, { reexecution: true, rootFloor: true });
  await commitSpineTreeScopes({ store, ...receipt });
  const spawned = read(store);
  assert.equal(spawned.branches.assignment.memoryVersion, 1);
  for (const id of ["child-0", "child-1"]) {
    assert.equal(spawned.branches[id].parent, "assignment");
    assert.equal(spawned.branches[id].memoryVersion, 1);
    assert.equal(spawned.registry[id].status, "ended");
  }
  const opened = await commit([["result-open", { type: "open", summary: "accepted result" }]]);
  const first = await commitSpineTreeScopes({ store, ...opened, alignment: "one-to-one" });
  assert.equal(first.selections.find(item => JSON.stringify(item.nodeId) === JSON.stringify(opened.projection.cursor)).branch, "assignment");
  await commitSpineTreeScopes({ store, ...await commit([["detail-open", { type: "open", summary: "detail" }]]), alignment: "one-to-one" });
  await commitSpineTreeScopes({ store, ...await commit([["detail-close", { type: "close", memory: "detail evidence" }]]), alignment: "one-to-one" });
  await commitSpineTreeScopes({ store, ...await commit([["result-close", { type: "close", memory: "v2" }]]), alignment: "one-to-one" });
  const after = read(store);
  assert.equal(after.branches.assignment.memoryVersion, 2);
  assert.equal(after.branches.assignment.parent, "root");
  assert.equal(after.branches.assignment.reexecution.state, "completed");
  for (const id of ["child-0", "child-1"]) assert.deepEqual(after.branches[id], spawned.branches[id]);
});

for (const omit of [false, true]) test(`reexecution cannot omit or forge RootEpoch Spawn handoff (${omit ? "omit" : "unverified"})`, async t => {
  const { store, receipt } = await fixture(t, { reexecution: true, rootFloor: true });
  const head = store.head();
  const before = read(store);
  const invalid = { store, ...receipt, ...(omit ? { alignment: undefined, selections: [] } : { selections: [] }) };
  await assert.rejects(commitSpineTreeScopes(invalid), { code: "binding-conflict" });
  assert.equal(store.head(), head);
  assert.deepEqual(read(store), before);
});

test("a reexecution may continue after its earlier Spawn result itself has a newer execution", async t => {
  const { store, commit, receipt } = await fixture(t, { reexecution: true, rootFloor: true });
  await commitSpineTreeScopes({ store, ...receipt });
  const registry = new GitSpineTreeAgentRegistry(store);
  const { binding } = await registry.rejuvenate({ parent: "assignment", branch: "child-0" }, {
    provision: context => ({ ...working("successor", "child-0"), operationId: context.executionId }),
  });
  const successor = await canonical(t, binding, store);
  await commitSpineTreeScopes({ store, ...await successor([["successor-open", { type: "open", summary: "refine child result" }]]), alignment: "one-to-one" });
  await commitSpineTreeScopes({ store, ...await successor([["successor-close", { type: "close", memory: "child v2" }]]), alignment: "one-to-one" });
  await registry.transition("successor", "ended");
  const refined = read(store).branches["child-0"];
  await commitSpineTreeScopes({ store, ...await commit([]), alignment: "one-to-one" });
  await commitSpineTreeScopes({ store, ...await commit([["open", { type: "open", summary: "integrate" }]]), alignment: "one-to-one" });
  await commitSpineTreeScopes({ store, ...await commit([["close", { type: "close", memory: "parent v2" }]]), alignment: "one-to-one" });
  assert.deepEqual(read(store).branches["child-0"], refined);
  assert.equal(refined.memoryVersion, 2);
});

for (const operation of [
  { type: "close", memory: "must return through typed Spawn instead" },
  { type: "next", closed_memory: "cannot escape floor", next_summary: "foreign sibling" },
]) test(`child cannot ${operation.type} its inherited Task assignment floor`, async t => {
  const { store, children } = await fixture(t);
  const snapshot = read(store);
  snapshot.registry["child-0"].status = "running";
  store.commitSnapshot(store.head(), snapshot, "test: child still owns its lease");
  await commitSpineTreeScopes({ store, ...await children[0]([["detail-close", { type: "close", memory: "local detail done" }]]), alignment: "one-to-one" });
  const invalid = await children[0]([["floor-escape", operation]]);
  const head = store.head();
  const before = read(store);
  await assert.rejects(commitSpineTreeScopes({ store, ...invalid, alignment: "one-to-one" }), { code: "binding-conflict" });
  assert.equal(store.head(), head);
  assert.deepEqual(read(store), before);
});
