import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitSpineTreeAgentRegistry,
  GitSpineTreeStore,
  MemoryAgentRegistry,
  SpineTreeRegistryError,
} from "../dist/index.js";

const binding = {
  agentId: "agent-1",
  sessionId: "session-1",
  branch: "root",
  scope: "scope-1",
  status: "running",
};

const snapshot = {
  branches: {
    root: {
      id: "root",
      parent: null,
      goal: "project",
      constraints: [],
      skills: [],
      tools: [],
      memory: null,
      memoryVersion: 0,
      memorySource: null,
      status: "live",
    },
  },
  schema: "spinetree.snapshot/v2",
};

test("MemoryAgentRegistry enforces the explicit status transition matrix", () => {
  const registry = new MemoryAgentRegistry();
  registry.register(binding);
  assert.deepEqual(registry.transition(binding.agentId, "running"), binding);
  assert.equal(registry.transition(binding.agentId, "paused").status, "paused");
  assert.equal(registry.transition(binding.agentId, "running").status, "running");
  const ended = registry.transition(binding.agentId, "ended");
  assert.deepEqual(ended, { ...binding, status: "ended" });
  assert.deepEqual(registry.transition(binding.agentId, "ended"), ended);
  assert.deepEqual(registry.resolve(binding.agentId), ended);
  assert.deepEqual(registry.resolve(binding.agentId), ended);
  assert.throws(
    () => registry.transition(binding.agentId, "running"),
    error => error instanceof SpineTreeRegistryError && error.code === "invalid-transition",
  );
  assert.throws(
    () => registry.transition("missing", "ended"),
    error => error instanceof SpineTreeRegistryError && error.code === "unknown-agent",
  );
  assert.throws(
    () => registry.transition(binding.agentId, "invalid"),
    error => error instanceof SpineTreeRegistryError && error.code === "invalid-transition",
  );
});

test("WorkingBinding carries a lease and cursor, and stale leases fail closed", () => {
  const registry = new MemoryAgentRegistry();
  const working = {
    ...binding,
    bindingId: "binding-1",
    leaseId: "lease-1",
    operationId: "operation-1",
    epoch: 0,
    scopeCursor: [0],
  };
  registry.registerWorkingExclusive(working);
  assert.deepEqual(registry.updateWorking("agent-1", "lease-1", { epoch: 1, scopeCursor: [0, 1] }), {
    ...working,
    epoch: 1,
    scopeCursor: [0, 1],
  });
  assert.throws(
    () => registry.updateWorking("agent-1", "stale-lease", { epoch: 2, scopeCursor: [0, 1, 0] }),
    error => error instanceof SpineTreeRegistryError && error.code === "stale-lease",
  );
  registry.transition("agent-1", "ended");
  assert.throws(
    () => registry.updateWorking("agent-1", "lease-1", { epoch: 2, scopeCursor: [0, 1, 0] }),
    error => error instanceof SpineTreeRegistryError && error.code === "stale-lease",
  );
});

test("GitAgentRegistry persists status transitions and preserves binding identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-lifecycle-git-"));
  const store = GitSpineTreeStore.initialize(root, snapshot);
  const registry = new GitSpineTreeAgentRegistry(store);
  await registry.register(binding);
  const paused = await registry.transition(binding.agentId, "paused");
  assert.deepEqual(paused, { ...binding, status: "paused" });
  const reloaded = new GitSpineTreeAgentRegistry(new GitSpineTreeStore(root));
  assert.deepEqual(await reloaded.resolve(binding.agentId), paused);
  const ended = await reloaded.transition(binding.agentId, "ended");
  assert.deepEqual(ended, { ...binding, status: "ended" });
  await assert.rejects(
    reloaded.transition(binding.agentId, "running"),
    error => error instanceof SpineTreeRegistryError && error.code === "invalid-transition",
  );
  assert.deepEqual(await new GitSpineTreeAgentRegistry(new GitSpineTreeStore(root)).resolve(binding.agentId), ended);
});
