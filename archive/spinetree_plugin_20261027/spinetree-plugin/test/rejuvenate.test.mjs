import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSpineTreePlugin, GitSpineTreeAgentRegistry, GitSpineTreeStore,
  MemorySpineTreeStore, SPINETREE_REJUVENATE_RESULT_SCHEMA } from "../dist/index.js";
import { SpinePluginHost } from "@spinejit/spine-host";

const canonicalPlugin = {
  manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0", owns: ["spine.canonical"] }, activate() {},
};
export const fixtureSnapshot = () => ({ branches: {
  root: { id: "root", parent: null, goal: "project", constraints: ["c0"], skills: ["s0"], tools: ["t0"], memory: "root-memory", memoryVersion: 1, memorySource: "root-scope", status: "live" },
  child: { id: "child", parent: "root", goal: "child goal", constraints: ["c1"], skills: ["s1"], tools: ["t1"], memory: "child-memory", memoryVersion: 1, memorySource: "old-scope", status: "capped" },
  live: { id: "live", parent: "root", goal: "live", constraints: [], skills: [], tools: [], memory: null, memoryVersion: 0, memorySource: null, status: "live" },
}, schema: "spinetree.snapshot/v2" });
export const provisionBinding = context => ({ agentId: "agent-child", sessionId: "session-child", branch: "child", scope: "scope-new", status: "running",
  bindingId: "binding-child", leaseId: "lease-child", operationId: context.executionId, epoch: 0, scopeCursor: [0] });
export async function fixture(t, rejuvenator) {
  const temp = process.env.SPINETREE_TEST_TEMP ?? resolve("temp/null/20260926_2002/reexecution");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "store-"));
  const store = GitSpineTreeStore.initialize(root, fixtureSnapshot());
  const registry = new GitSpineTreeAgentRegistry(store);
  const host = new SpinePluginHost();
  host.register(canonicalPlugin);
  host.register(createSpineTreePlugin({ store, registry, rejuvenator }));
  await host.activateAll(); t.after(() => host.dispose());
  return { root, store, registry, host };
}

test("rejuvenates a capped branch with atomic WorkingBinding and retained source", async t => {
  let received, readyState;
  const f = await fixture(t, {
    provision(context) { received = context; return provisionBinding(context); },
    async ready(binding) { readyState = await f.store.readSnapshot(await f.store.head()); assert.deepEqual(await f.registry.resolve(binding.agentId), binding); },
  });
  const sourceHead = await f.store.head();
  const result = await f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child", request: "continue" });
  assert.equal(result.schema, SPINETREE_REJUVENATE_RESULT_SCHEMA);
  assert.equal(received.sourceHead, sourceHead);
  assert.deepEqual(received.inherit.path, ["root", "child"]);
  assert.equal(received.inherit.memories[1].memory, "child-memory");
  assert.equal(received.request, "continue");
  assert.equal(readyState.branches.child.status, "live");
  assert.equal(readyState.branches.child.memoryVersion, 1);
  assert.equal(readyState.branches.child.memorySource, "old-scope");
  assert.equal(readyState.branches.child.reexecution.state, "running");
  assert.equal(readyState.branches.child.reexecution.source.memory, "child-memory");
  const reloaded = new GitSpineTreeAgentRegistry(new GitSpineTreeStore(f.root));
  assert.deepEqual(await reloaded.list("child"), [result.binding]);
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), { code: "branch-not-capped" });
});

test("rejuvenate is contract-only without a transactional registry or provisioner", async t => {
  const host = new SpinePluginHost(); host.register(canonicalPlugin);
  host.register(createSpineTreePlugin({ store: new MemorySpineTreeStore(fixtureSnapshot()) }));
  await host.activateAll(); t.after(() => host.dispose());
  assert.equal((await host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" })).status, "contract-only");
});

test("rejects invalid-parent, live and occupied branch before provisioning", async t => {
  let calls = 0;
  const f = await fixture(t, { provision() { calls++; throw new Error("must not provision"); } });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "live" }), { code: "branch-not-capped" });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "live", branch: "child" }), { code: "invalid-parent" });
  await f.registry.registerExclusive({ agentId: "existing", sessionId: "other", branch: "child", status: "running" });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), { code: "branch-occupied" });
  assert.equal(calls, 0);
});

test("two concurrent rejuvenations reserve once before provisioning", async t => {
  let release, reached, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, { async provision(context) { count++; reached(); await gate; return provisionBinding(context); } });
  const first = f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" });
  await entered;
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), { code: "branch-occupied" });
  await assert.rejects(f.registry.registerWorkingExclusive({ ...provisionBinding({ executionId: "other" }), agentId: "racer" }), { code: "branch-occupied" });
  release(); await first;
  assert.equal(count, 1);
  assert.equal((await f.registry.list("child")).length, 1);
});

test("failed provision leaves capped source and no phantom Agent", async t => {
  const f = await fixture(t, { provision() { throw new Error("allocation failed"); } });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), /allocation failed/);
  const state = await f.store.readSnapshot(await f.store.head());
  assert.deepEqual(await f.registry.list(), []);
  assert.equal(state.branches.child.status, "capped");
  assert.equal(state.branches.child.memoryVersion, 1);
  assert.equal(state.branches.child.reexecution.state, "failed");
});

test("failed readiness releases session and preserves ended execution provenance", async t => {
  let released = 0;
  const f = await fixture(t, { provision: provisionBinding, ready() { throw new Error("attach failed"); }, async release() {
    const state = await f.store.readSnapshot(await f.store.head());
    assert.equal(state.registry["agent-child"].status, "ended");
    assert.equal(state.branches.child.reexecution.state, "failed");
    released++;
  } });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), /attach failed/);
  const state = await f.store.readSnapshot(await f.store.head());
  assert.equal(released, 1);
  assert.equal(state.registry["agent-child"].status, "ended");
  assert.equal(state.branches.child.status, "capped");
  assert.equal(state.branches.child.reexecution.state, "failed");
  assert.equal(state.branches.child.memory, "child-memory");
});

for (const { replacement, target = "both" } of [
  { replacement: { leaseId: "replacement-lease" } },
  { replacement: { operationId: "replacement-operation" } },
  { replacement: { leaseId: "replacement-lease" }, target: "registry" },
  { replacement: { leaseId: "replacement-lease" }, target: "branch" },
  { replacement: { scopeCursor: [0, 1] }, target: "registry" },
]) {
  test(`failed readiness preserves a replacement ${Object.keys(replacement)[0]} in ${target}`, async t => {
    const store = new MemorySpineTreeStore(fixtureSnapshot());
    const registry = new GitSpineTreeAgentRegistry(store);
    let replacementHead, replacementSnapshot, released = 0;
    const operation = registry.rejuvenate({ parent: "root", branch: "child" }, {
      provision: provisionBinding,
      ready(binding) {
        const next = store.readSnapshot(store.head());
        const successor = { ...binding, ...replacement };
        if (target !== "branch") next.registry[binding.agentId] = successor;
        if (target !== "registry") next.branches.child.reexecution.binding = successor;
        store.commitSnapshot(store.head(), next, "host: replace execution ownership");
        replacementHead = store.head();
        replacementSnapshot = store.readSnapshot(replacementHead);
        throw new Error("old attach failed");
      },
      release() { released++; },
    });
    let failure;
    await assert.rejects(operation, error => { failure = error; return true; });
    t.diagnostic(JSON.stringify({ replacement, target, replacementHead, finalHead: store.head(),
      finalStatus: store.readSnapshot(store.head()).registry["agent-child"].status, released }));
    assert.equal(store.head(), replacementHead);
    assert.deepEqual(store.readSnapshot(store.head()), replacementSnapshot);
    assert.equal(released, 0);
    assert.equal(failure.code, "invalid-binding");
  });
}

test("failed readiness rechecks ownership after a cleanup CAS conflict", async () => {
  const store = new MemorySpineTreeStore(fixtureSnapshot());
  let ownedBinding, replacementHead, replacementSnapshot, released = 0;
  const registry = new GitSpineTreeAgentRegistry({
    head: () => store.head(), readSnapshot: head => store.readSnapshot(head),
    commitSnapshot(head, snapshot, message) {
      if (message === "spinetree: fail reexecution" && replacementHead === undefined) {
        const replacement = store.readSnapshot(head);
        const successor = { ...ownedBinding, leaseId: "replacement-lease" };
        replacement.registry[successor.agentId] = successor;
        replacement.branches.child.reexecution.binding = successor;
        store.commitSnapshot(head, replacement, "host: replace before cleanup commit");
        replacementHead = store.head();
        replacementSnapshot = store.readSnapshot(replacementHead);
      }
      return store.commitSnapshot(head, snapshot, message);
    },
  });
  await assert.rejects(registry.rejuvenate({ parent: "root", branch: "child" }, {
    provision: provisionBinding,
    ready(binding) { ownedBinding = binding; throw new Error("old attach failed"); },
    release() { released++; },
  }), { code: "invalid-binding" });
  assert.equal(store.head(), replacementHead);
  assert.deepEqual(store.readSnapshot(store.head()), replacementSnapshot);
  assert.equal(released, 0);
});

test("readiness and release failures preserve both errors after fencing the failed owner", async () => {
  const store = new MemorySpineTreeStore(fixtureSnapshot());
  const registry = new GitSpineTreeAgentRegistry(store);
  const attachFailure = new Error("attach failed");
  const releaseFailure = new Error("release failed");
  await assert.rejects(registry.rejuvenate({ parent: "root", branch: "child" }, {
    provision: provisionBinding,
    ready() { throw attachFailure; },
    release() { throw releaseFailure; },
  }), error => error instanceof AggregateError &&
    error.errors[0] === attachFailure && error.errors[1] === releaseFailure);
  const final = store.readSnapshot(store.head());
  assert.equal(final.registry["agent-child"].status, "ended");
  assert.equal(final.branches.child.reexecution.state, "failed");
});

test("rejects stale source revision and unrelated provision identity", async t => {
  const f = await fixture(t, { async provision(context) {
    await f.store.change(await f.store.head(), [{ type: "update", branch: "child", attributes: { goal: "changed" } }]);
    return provisionBinding(context);
  } });
  await assert.rejects(f.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), { code: "invalid-binding" });
  assert.equal((await f.registry.list()).length, 0);
  const g = await fixture(t, { provision: context => ({ ...provisionBinding(context), operationId: "unrelated" }) });
  await assert.rejects(g.host.executeTool("spinetree_rejuvenate", { parent: "root", branch: "child" }), { code: "invalid-binding" });
  assert.equal((await g.registry.list()).length, 0);
});

test("failed publication keeps source memory and never exposes a live binding", async t => {
  const f = await fixture(t, { provision: provisionBinding }); let released = 0;
  const registry = new GitSpineTreeAgentRegistry({
    head: () => f.store.head(), readSnapshot: head => f.store.readSnapshot(head),
    commitSnapshot(head, snapshot, message) {
      if (message === "spinetree: start reexecution") throw new Error("deterministic CAS publication failure");
      return f.store.commitSnapshot(head, snapshot, message);
    },
  });
  await assert.rejects(registry.rejuvenate({ parent: "root", branch: "child" }, { provision: provisionBinding, release() { released++; } }), /publication failure/);
  const branch = (await f.store.readSnapshot(await f.store.head())).branches.child;
  assert.equal(released, 1); assert.equal(branch.status, "capped"); assert.equal(branch.memory, "child-memory");
  assert.equal(branch.reexecution.state, "failed"); assert.equal((await f.registry.list()).length, 0);
});

test("simultaneous reservation CAS from two registry instances has exactly one provision winner", async t => {
  const f = await fixture(t, { provision: provisionBinding }); let calls = 0;
  const provisioner = { provision(context) { calls++; return provisionBinding(context); } };
  const other = new GitSpineTreeAgentRegistry(new GitSpineTreeStore(f.root));
  const outcomes = await Promise.allSettled([
    f.registry.rejuvenate({ parent: "root", branch: "child" }, provisioner),
    other.rejuvenate({ parent: "root", branch: "child" }, provisioner),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected" && ["branch-occupied", "branch-not-capped"].includes(outcome.reason.code)).length, 1);
  assert.equal(calls, 1); assert.equal((await f.registry.list("child")).length, 1);
});
