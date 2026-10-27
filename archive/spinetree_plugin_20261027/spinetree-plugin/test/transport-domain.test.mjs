import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpinePluginHost } from "@spinejit/spine-host";
import { createSpineTreePlugin, dispatchSpineTreeMailbox, MemoryAgentRegistry, MemorySpineTreeMailbox,
  GitSpineTreeAgentRegistry, GitSpineTreeMailbox, GitSpineTreeStore } from "../dist/index.js";

const binding = id => ({ agentId: id, sessionId: `session-${id}`, branch: id, status: "running",
  bindingId: `binding-${id}`, leaseId: `working-${id}`, operationId: id, epoch: 0, scopeCursor: [0] });
const pin = ({ agentId, sessionId, bindingId, leaseId }) => ({ agentId, sessionId, bindingId, leaseId });
const canonical = { manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} };
async function fixture(t, kind) {
  const store = kind === "git" ? GitSpineTreeStore.initialize(await mkdtemp(join(tmpdir(), "mailbox-domain-")), { branches: {}, schema: "spinetree.snapshot/v2" }) : undefined;
  const registry = store ? new GitSpineTreeAgentRegistry(store) : new MemoryAgentRegistry();
  const mailbox = store ? new GitSpineTreeMailbox(store) : new MemorySpineTreeMailbox();
  const a = binding("a"), b = binding("b"), root = binding("root");
  for (const item of [a, b, root]) await registry.registerWorkingExclusive(item);
  const hosts = [];
  async function host(domain) {
    const value = new SpinePluginHost(); value.register(canonical);
    value.register(createSpineTreePlugin({ registry, mailbox, ...(domain ? { transportDomain: domain } : {}) }));
    await value.activateAll(); hosts.push(value); return value;
  }
  t.after(async () => { for (const value of hosts) await value.dispose(); });
  return { store, registry, mailbox, a, b, root, host };
}

for (const kind of ["memory", "git"]) {
  test(`${kind}: scoped admission rejects foreign endpoints without enqueue; queue-only host remains explicit`, async t => {
    const f = await fixture(t, kind); const aHost = await f.host(() => [pin(f.a)]);
    const before = f.store?.head();
    for (const to of ["root", "b"]) {
      await assert.rejects(aHost.executeTool("spinetree_send", { to, message: "unreachable" }), { code: "recipient-unavailable" });
    }
    assert.equal(f.store?.head(), before);
    assert.deepEqual(await f.mailbox.pending(10), []);
    const generic = await f.host();
    const queued = await generic.executeTool("spinetree_send", { to: "root", message: "queue only" });
    assert.equal(queued.receipt.recipient, undefined);
    assert.equal(queued.status, "queued");
    const sent = await aHost.executeTool("spinetree_send", { to: "a", message: "owned", requestId: "stable" });
    assert.deepEqual(sent.receipt.recipient, pin(f.a));
    assert.deepEqual(await aHost.executeTool("spinetree_send", { to: "a", message: "owned", requestId: "stable" }), sent);
  });

  test(`${kind}: foreign and stale pins do not consume local dispatch limit or lease attempts`, async t => {
    const f = await fixture(t, kind);
    const aHost = await f.host(() => [pin(f.a)]), bHost = await f.host(() => [pin(f.b)]);
    const foreign = (await bHost.executeTool("spinetree_send", { to: "b", message: "first" })).receipt;
    const local = (await aHost.executeTool("spinetree_send", { to: "a", message: "second" })).receipt;
    const calls = [];
    const result = await dispatchSpineTreeMailbox({ ...f, transportDomain: () => [pin(f.a)], limit: 1,
      sessions: { async request(request) { calls.push(request); return { accepted: true }; } } });
    assert.deepEqual(result.receipts.map(receipt => receipt.id), [local.id]);
    assert.equal((await f.mailbox.receipt(foreign.id)).attempt, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetSessionId, f.a.sessionId);
    const observed = await aHost.executeTool("spinetree_observe", { agentId: "a", receiptId: local.id });
    assert.equal(observed.receipt.status, "observed");
    const old = await f.mailbox.enqueue({ to: "a", from: null, message: "old", recipient: pin(f.a) });
    const newIdentity = { ...pin(f.a), leaseId: "replacement-lease" };
    assert.deepEqual(await f.mailbox.pending(1, [newIdentity]), []);
    await assert.rejects(async () => f.mailbox.lease(old.id, newIdentity), { code: "lease-conflict" });
    await assert.rejects(async () => f.mailbox.lease(old.id), { code: "lease-conflict" });
    assert.equal((await f.mailbox.receipt(old.id)).attempt, 0);
  });

  test(`${kind}: one winner for concurrent scoped dispatch; expired lease retries exact recipient`, async t => {
    const f = await fixture(t, kind); const aHost = await f.host(() => [pin(f.a)]);
    const receipt = (await aHost.executeTool("spinetree_send", { to: "a", message: "one" })).receipt;
    const select = f.mailbox.pending.bind(f.mailbox); const barrier = Promise.withResolvers(); let selected = 0;
    f.mailbox.pending = async (...args) => {
      const result = await select(...args); if (++selected === 2) barrier.resolve(); await barrier.promise; return result;
    };
    let requests = 0;
    const args = { ...f, transportDomain: () => [pin(f.a)], sessions: { async request() { requests++; return { accepted: true }; } } };
    const results = await Promise.all([dispatchSpineTreeMailbox(args), dispatchSpineTreeMailbox(args)]);
    assert.equal(requests, 1);
    assert.equal(results.flatMap(result => result.receipts).length, 1);
    assert.equal((await f.mailbox.receipt(receipt.id)).attempt, 1);
    f.mailbox.pending = select;
    let now = 1_000; t.mock.method(Date, "now", () => now);
    const queued = (await aHost.executeTool("spinetree_send", { to: "a", message: "expired" })).receipt;
    const first = await f.mailbox.lease(queued.id, pin(f.a)); now = first.leaseUntil;
    const retried = await dispatchSpineTreeMailbox(args);
    assert.equal(retried.receipts[0].attempt, 2);
    assert.deepEqual(retried.receipts[0].recipient, pin(f.a));
    await assert.rejects(async () => f.mailbox.delivered(queued.id, first.leaseId, f.a.bindingId), { code: "lease-conflict" });
  });

  test(`${kind}: stale domain is rejected before queue mutation and never retargets pinned mail`, async t => {
    const f = await fixture(t, kind);
    const stale = { ...pin(f.a), sessionId: "former-session" };
    const staleHost = await f.host(() => [stale]); const head = f.store?.head();
    await assert.rejects(staleHost.executeTool("spinetree_send", { to: "a", message: "stale" }), { code: "recipient-unavailable" });
    assert.equal(f.store?.head(), head);
    const aHost = await f.host(() => [pin(f.a)]);
    const receipt = (await aHost.executeTool("spinetree_send", { to: "a", message: "pinned" })).receipt;
    const changed = { ...f.a, sessionId: "new-session", leaseId: "new-working-lease" };
    const result = await dispatchSpineTreeMailbox({ registry: { resolve: () => changed }, mailbox: f.mailbox,
      transportDomain: () => [pin(changed)], sessions: { async request() { assert.fail("must not deliver to replacement"); } } });
    assert.deepEqual(result.receipts, []);
    assert.equal((await f.mailbox.receipt(receipt.id)).attempt, 0);
    // The same protection applies if a queue-only dispatcher sees a pinned receipt.
    const unscoped = await dispatchSpineTreeMailbox({ registry: { resolve: () => changed }, mailbox: f.mailbox,
      sessions: { async request() { assert.fail("must not retarget"); } } });
    assert.deepEqual(unscoped.skipped, [receipt.id]);
  });
}

test("Git admission and lease CAS reject replacement between selection and write", async t => {
  const f = await fixture(t, "git"); const aHost = await f.host(() => [pin(f.a)]);
  const enqueue = f.mailbox.enqueue.bind(f.mailbox); let replacementHead;
  f.mailbox.enqueue = async input => {
    const head = f.store.head(), snapshot = f.store.readSnapshot(head);
    snapshot.registry.a = { ...f.a, leaseId: "replaced" };
    replacementHead = f.store.commitSnapshot(head, snapshot).head;
    return enqueue(input);
  };
  await assert.rejects(aHost.executeTool("spinetree_send", { to: "a", message: "race" }), { code: "mailbox-error" });
  assert.equal(f.store.head(), replacementHead, "failed admission performs no mailbox commit");
  assert.deepEqual(await f.mailbox.pending(10), []);
  f.mailbox.enqueue = enqueue;
  const replacement = { ...f.a, leaseId: "replaced" };
  const receipt = await enqueue({ to: "a", from: null, message: "lease-race", recipient: pin(replacement) });
  const head = f.store.head(), snapshot = f.store.readSnapshot(head);
  snapshot.registry.a = f.a; const reverted = f.store.commitSnapshot(head, snapshot).head;
  await assert.rejects(f.mailbox.lease(receipt.id, pin(replacement)), { code: "lease-conflict" });
  assert.equal(f.store.head(), reverted);
  assert.equal((await f.mailbox.receipt(receipt.id)).attempt, 0);
});

test("Git pinned delivery and observation reject a replacement between read and CAS", async t => {
  const f = await fixture(t, "git");
  const admitted = await f.mailbox.enqueue({ to: "a", from: null, message: "pinned", requestId: "pinned-key", recipient: pin(f.a) });
  const leased = await f.mailbox.lease(admitted.id, pin(f.a));
  const head = f.store.head(), snapshot = f.store.readSnapshot(head);
  const replacement = { ...f.a, leaseId: "next-lease" };
  snapshot.registry.a = replacement; const replacedHead = f.store.commitSnapshot(head, snapshot).head;
  await assert.rejects(f.mailbox.delivered(admitted.id, leased.leaseId, f.a.bindingId), { code: "lease-conflict" });
  await assert.rejects(f.mailbox.observed(admitted.id, leased.leaseId, f.a.bindingId), { code: "lease-conflict" });
  await assert.rejects(f.mailbox.enqueue({ to: "a", from: null, message: "pinned", requestId: "pinned-key", recipient: pin(replacement) }), { code: "invalid-state" });
  assert.equal(f.store.head(), replacedHead);
  assert.equal((await f.mailbox.receipt(admitted.id)).status, "leased");
});
