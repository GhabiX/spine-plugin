import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { SpineController } from "@spinejit/pi-spinejit";
import { SpinePluginHost } from "@spinejit/spine-host";
import {
  MemorySpineTreeStore, GitSpineTreeAgentRegistry, createSpineTreePlugin, commitSpineTreeScopes,
} from "../dist/index.js";

async function fixture(t) {
  const root = { id: "root", parent: null, goal: "project", status: "live", constraints: [], skills: [], tools: [], memory: null, memoryVersion: 0, memorySource: null };
  const owner = { agentId: "parent", sessionId: "parent-session", branch: "root", status: "running", bindingId: "parent-binding", leaseId: "parent-lease", operationId: "parent-operation", epoch: 0, scopeCursor: [0] };
  const store = new MemorySpineTreeStore({ schema: "spinetree.snapshot/v2", branches: { root }, registry: { parent: owner } });
  const registry = new GitSpineTreeAgentRegistry(store);
  const host = new SpinePluginHost();
  host.register({ manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} });
  host.register(createSpineTreePlugin({ store, registry }));
  await host.activateAll(); t.after(() => host.dispose());
  const state = () => store.readSnapshot(store.head());
  async function sampler(binding) {
    const runtime = createNodeSpineRuntime({ thread: binding.sessionId, features: ["jit", "spawn"] }); t.after(() => runtime.dispose());
    const controller = new SpineController(runtime.client, { async persist() {} }, { async publish() {} });
    await controller.observeSources([{ type: "message", boundary: 0, role: "user", content: "complete and reorganize work" }]);
    let boundary = 0;
    return async operation => {
      await controller.beginSampling(); const key = `tool-${++boundary}`;
      if (operation) await controller.registerExecution(key);
      await controller.observeSources([{ type: "message", boundary, role: "assistant", content: operation?.type ?? "continue" }]);
      if (operation) { await controller.stageExecution(key, key, operation); await controller.finishExecution(key, true); }
      const result = await controller.finishSampling({ terminal: "completed" });
      // Supply the candidate cursor; scope import must publish it atomically.
      return { store, agentId: binding.agentId, sessionId: binding.sessionId, transactionId: result.transactionId,
        record: result.record.record, projection: result.projection, alignment: "one-to-one",
        binding: { ...state().registry[binding.agentId], epoch: result.record.record.epoch, scopeCursor: result.projection.cursor } };
    };
  }
  const sample = await sampler(owner);
  const change = async (id, operation) => {
    const read = await host.executeTool("spinetree_read", { branch: id });
    return host.executeTool("spinetree_change", { changes: [{ ...operation, branch: id, expectedRevision: read.revision }] });
  };
  const open = async goal => {
    const receipt = await sample({ type: "open", summary: goal });
    const result = await commitSpineTreeScopes(receipt);
    return result.selections.find(s => JSON.stringify(s.nodeId) === JSON.stringify(receipt.projection.cursor)).branch;
  };
  const close = async () => commitSpineTreeScopes(await sample({ type: "close", memory: "checked result and source" }));
  return { store, state, registry, host, sample, sampler, change, open, close };
}

for (const explicit of [false, true]) test(`archived terminal mapping survives continuation (${explicit ? "explicit" : "aligned"}) without resurrection`, async t => {
  const f = await fixture(t);
  const id = await f.open("finished result"); await f.close();
  const before = f.state().branches[id];
  assert.equal((await f.change(id, { type: "archive" })).applied, true);
  const archived = f.state().branches[id];
  assert.equal(archived.status, "archived");
  for (const key of ["id", "parent", "scopeBinding", "memory", "memoryVersion", "memorySource"]) assert.deepEqual(archived[key], before[key]);
  const next = await f.sample();
  const nodeId = before.scopeBinding.nodeId;
  const receipt = explicit ? { ...next, alignment: undefined, selections: [{ nodeId, branch: id }] } : next;
  const priorHead = f.store.head();
  const forged = { ...receipt, projection: { ...receipt.projection, nodes: receipt.projection.nodes.map(n => JSON.stringify(n.id) === JSON.stringify(nodeId) ? { ...n, status: "Live", memory: null } : n) } };
  await assert.rejects(commitSpineTreeScopes(forged), { code: "binding-conflict" });
  assert.equal(f.store.head(), priorHead);
  await assert.rejects(commitSpineTreeScopes({ ...next, selections: [{ nodeId, branch: "root" }] }), { code: "binding-conflict" });
  assert.equal(f.store.head(), priorHead);
  await assert.rejects(commitSpineTreeScopes({ ...receipt, binding: { ...receipt.binding, leaseId: "foreign-lease" } }), { code: "binding-conflict" });
  assert.equal(f.store.head(), priorHead);
  const imported = await commitSpineTreeScopes(receipt);
  assert.deepEqual(f.state().branches[id], archived);
  assert.equal(imported.selections.find(s => JSON.stringify(s.nodeId) === JSON.stringify(nodeId)).branch, id);
  assert.equal((await commitSpineTreeScopes(receipt)).head, imported.head);
  const sibling = await f.open("later work"); assert.notEqual(sibling, id); await f.close();
  assert.deepEqual(f.state().branches[id], archived);
  assert.deepEqual(Object.keys(f.state().branches).sort(), ["root", id, sibling].sort());
});

test("an archived branch without a prior import mapping cannot acquire a new Scope", async t => {
  const f = await fixture(t);
  const id = await f.open("finished result"); await f.close();
  assert.equal((await f.change(id, { type: "archive" })).applied, true);
  const next = await f.sample({ type: "open", summary: "different work" });
  const head = f.store.head();
  await assert.rejects(commitSpineTreeScopes({ ...next, selections: [{ nodeId: next.projection.cursor, branch: id }] }), { code: "binding-conflict" });
  assert.equal(f.store.head(), head);
  await commitSpineTreeScopes(next);
  assert.equal(f.state().branches[id].status, "archived");
});

test("moving and archiving capped nested work preserves project parent, memory and old canonical mapping", async t => {
  const f = await fixture(t);
  const first = await f.open("first group"), detail = await f.open("checked detail"); await f.close(); await f.close();
  const second = await f.open("second group"); await f.close();
  const original = f.state().branches[detail];
  assert.equal((await f.change(detail, { type: "move", parent: second })).applied, true);
  await commitSpineTreeScopes(await f.sample());
  assert.equal(f.state().branches[detail].parent, second);
  for (const key of ["id", "scopeBinding", "memory", "memoryVersion", "memorySource"]) assert.deepEqual(f.state().branches[detail][key], original[key]);
  let head = f.store.head();
  await assert.rejects(f.change(second, { type: "move", parent: detail }), { code: "invalid-change" });
  assert.equal(f.store.head(), head);
  assert.equal((await f.change(detail, { type: "archive" })).applied, true);
  const archived = f.state().branches[detail]; await commitSpineTreeScopes(await f.sample());
  assert.deepEqual(f.state().branches[detail], archived);
  const live = await f.open("new live work"); head = f.store.head();
  await assert.rejects(f.change(live, { type: "move", parent: first }), { code: "invalid-change" });
  await assert.rejects(f.change(live, { type: "archive" }), { code: "invalid-change" });
  assert.equal(f.store.head(), head); await f.close();
});

test("archived revised memory survives the original parent's historical terminal refresh", async t => {
  const f = await fixture(t);
  const id = await f.open("original result"); await f.close();
  const original = f.state().branches[id];
  const { binding } = await f.registry.rejuvenate({ parent: "root", branch: id }, { provision: context => ({ agentId: "child", sessionId: "child-session", branch: id, status: "running", bindingId: "child-binding", leaseId: "child-lease", operationId: context.executionId, epoch: 0, scopeCursor: [0] }) });
  const child = await f.sampler(binding);
  await commitSpineTreeScopes(await child({ type: "open", summary: "recheck result" }));
  await commitSpineTreeScopes(await child({ type: "close", memory: "revised and checked result" }));
  await f.registry.transition("child", "ended");
  assert.equal(f.state().branches[id].memoryVersion, 2);
  assert.equal((await f.change(id, { type: "archive" })).applied, true);
  const archived = f.state().branches[id];
  assert.deepEqual(archived.reexecution.source.memory, original.memory);
  const receipt = await f.sample(); await commitSpineTreeScopes(receipt);
  assert.deepEqual(f.state().branches[id], archived);
  const head = f.store.head(); assert.equal((await commitSpineTreeScopes(receipt)).head, head);
});
