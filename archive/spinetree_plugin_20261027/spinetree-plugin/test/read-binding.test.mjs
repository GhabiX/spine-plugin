import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpinePluginHost } from "@spinejit/spine-host";
import {
  dispatchSpineTreeMailbox, createSpineTreePlugin, GitSpineTreeStore, GitSpineTreeAgentRegistry,
  GitSpineTreeMailbox, MemorySpineTreeStore,
} from "../dist/index.js";

const branch = {
  id: "root", parent: null, goal: "project", constraints: [], skills: [], tools: [],
  memory: null, memoryVersion: 0, memorySource: null, status: "live",
};
const snapshot = { branches: { root: branch }, schema: "spinetree.snapshot/v2" };
const binding = { agentId: "a", sessionId: "pi-a", branch: "root", scope: "scope-a", status: "running" };
async function hostFor(options, sessions) {
  const host = new SpinePluginHost({ sessions });
  host.register({ manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} });
  host.register(createSpineTreePlugin(options));
  await host.activateAll();
  return host;
}

test("persisted lifecycle binding is discoverable and routes read -> send -> observe after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-read-binding-"));
  const store = GitSpineTreeStore.initialize(root, snapshot);
  const registry = new GitSpineTreeAgentRegistry(store);
  await registry.register(binding);
  const reloaded = new GitSpineTreeStore(root);
  const calls = [];
  const mailbox = new GitSpineTreeMailbox(reloaded);
  const sessions = { async request(request) { calls.push(request); return { accepted: true }; } };
  const host = await hostFor({ store: reloaded, registry: new GitSpineTreeAgentRegistry(reloaded), mailbox }, sessions);
  const head = reloaded.head();
  const read = await host.executeTool("spinetree_read", { branch: "root" });
  assert.equal(read.schema, "spinetree.read.result/v2");
  assert.deepEqual(read.binding, binding);
  assert.equal(read.head, head);
  assert.deepEqual(await host.executeTool("spinetree_read", { branch: "root" }), read);
  assert.equal(reloaded.head(), head);
  assert.equal(Object.hasOwn(reloaded.readSnapshot(head), "agents"), false);
  const sent = await host.executeTool("spinetree_send", { to: read.binding.agentId, message: "hello" });
  assert.equal(sent.receipt.status, "queued");
  assert.deepEqual(calls, []);
  await dispatchSpineTreeMailbox({ registry, mailbox, sessions });
  assert.equal(calls[0].targetSessionId, read.binding.sessionId);
  assert.equal(JSON.parse(calls[0].text).message, "hello");
  assert.equal(JSON.parse(calls[0].text).receiptId, sent.receipt.id);
  const observed = await host.executeTool("spinetree_observe", { receiptId: sent.receipt.id, agentId: read.binding.agentId });
  assert.equal(observed.receipt.status, "observed");
  await registry.transition(binding.agentId, "paused");
  assert.deepEqual((await host.executeTool("spinetree_read", { branch: "root" })).binding, { ...binding, status: "paused" });
  await registry.transition(binding.agentId, "ended");
  assert.equal((await host.executeTool("spinetree_read", { branch: "root" })).binding, null);
  await host.dispose();
});

test("binding stays at captured HEAD even when lifecycle advances during read", async () => {
  const store = new MemorySpineTreeStore({ ...snapshot, registry: { a: binding } });
  const registry = new GitSpineTreeAgentRegistry(store);
  const captured = store.head();
  const calls = [];
  const host = await hostFor({
    store: {
      async head() { calls.push("head"); await registry.transition("a", "ended"); return captured; },
      readSnapshot(head) { calls.push(head); return store.readSnapshot(head); },
    },
    registry: { resolve() { assert.fail("read queried live registry"); } },
  });
  const read = await host.executeTool("spinetree_read", { branch: "root" });
  assert.equal(read.head, captured);
  assert.deepEqual(read.binding, binding);
  assert.deepEqual(calls, ["head", captured]);
  assert.equal((await registry.resolve("a")).status, "ended");
  read.binding.sessionId = "modified result";
  assert.equal(store.readSnapshot(captured).registry.a.sessionId, "pi-a");
  await host.dispose();
});

test("read ignores ended and other-branch bindings, and rejects ambiguous active bindings", async () => {
  const base = snapshot;
  for (const registry of [undefined, {}, { a: { ...binding, status: "ended" } }, { a: { ...binding, branch: "other" } }]) {
    const host = await hostFor({ store: new MemorySpineTreeStore({ ...base, registry }) });
    assert.equal((await host.executeTool("spinetree_read", { branch: "root" })).binding, null);
    await host.dispose();
  }
  const host = await hostFor({ store: new MemorySpineTreeStore({ ...base, registry: {
    a: binding, b: { ...binding, agentId: "b", status: "paused" },
  } }) });
  await assert.rejects(host.executeTool("spinetree_read", { branch: "root" }), { code: "ambiguous-binding" });
  await host.dispose();
});
