import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpinePluginHost } from "@spinejit/spine-host";
import {
  createSpineTreePlugin, dispatchSpineTreeMailbox, GitSpineTreeStore,
  GitSpineTreeMailbox, GitSpineTreeAgentRegistry, MemorySpineTreeMailbox, MemoryAgentRegistry,
} from "../dist/index.js";

async function fixture(kind, t) {
  const store = kind === "git"
    ? GitSpineTreeStore.initialize(await mkdtemp(join(tmpdir(), "spinetree-message-")), { branches: {}, schema: "spinetree.snapshot/v2" })
    : undefined;
  const mailbox = store ? new GitSpineTreeMailbox(store) : new MemorySpineTreeMailbox();
  const registry = store ? new GitSpineTreeAgentRegistry(store) : new MemoryAgentRegistry();
  const hosts = {};
  for (const agent of ["a", "b"]) {
    await registry.register({ agentId: agent, sessionId: `pi-${agent}`, branch: agent, status: "running" });
    const host = new SpinePluginHost({ sessions: { async request() { assert.fail("send must not dispatch"); } } });
    host.register({ manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0" }, activate() {} });
    host.register(createSpineTreePlugin({ registry, mailbox }));
    await host.activateAll();
    hosts[agent] = host;
    t.after(() => host.dispose());
  }
  return { store, mailbox, registry, hosts };
}

for (const kind of ["memory", "git"]) {
  test(`${kind}: recipient observes and replies inside prompt; late transport outcomes preserve observation`, async t => {
    const { mailbox, registry, hosts, store } = await fixture(kind, t);
    for (const outcome of ["accepted", "rejected", "disconnected", "permanent"]) {
      const input = { from: "a", to: "b", message: `hello\n\"${outcome}\"`, requestId: outcome };
      const sent = await hosts.a.executeTool("spinetree_send", input);
      assert.equal(sent.status, "queued");
      assert.equal(sent.receipt.attempt, 0);
      let reply;
      let observedHead;
      const first = await dispatchSpineTreeMailbox({ registry, mailbox, sessions: {
        async request(request) {
          const envelope = JSON.parse(request.text);
          assert.deepEqual(envelope, {
            schema: "spinetree.message/v1", receiptId: sent.receipt.id,
            leaseId: (await mailbox.receipt(sent.receipt.id)).leaseId, to: "b", from: "a", message: input.message,
          });
          assert.equal(request.targetSessionId, "pi-b");
          assert.equal(request.requestId, sent.receipt.id);
          assert.equal((await mailbox.receipt(sent.receipt.id)).status, "leased");
          const observe = { receiptId: envelope.receiptId, agentId: envelope.to, leaseId: envelope.leaseId };
          await assert.rejects(hosts.a.executeTool("spinetree_observe", { ...observe, agentId: "a" }), { code: "not-recipient" });
          await assert.rejects(hosts.b.executeTool("spinetree_observe", { ...observe, leaseId: "wrong" }), { code: "lease-conflict" });
          const observed = await hosts.b.executeTool("spinetree_observe", observe);
          assert.equal(observed.receipt.status, "observed");
          assert.equal(observed.receipt.leaseUntil, null);
          assert.deepEqual(await hosts.b.executeTool("spinetree_observe", observe), observed);
          reply = await hosts.b.executeTool("spinetree_send", {
            to: envelope.from, from: envelope.to, message: "reply", requestId: `reply-${envelope.receiptId}`,
          });
          assert.equal(reply.status, "queued");
          observedHead = store?.head();
          if (outcome === "disconnected") throw new Error("ack lost");
          if (outcome === "permanent") throw Object.assign(new Error("stopped"), { permanent: true });
          return { accepted: outcome === "accepted" };
        },
      } });
      assert.deepEqual(first.receipts.map(r => [r.id, r.status]), [[sent.receipt.id, "observed"]]);
      assert.equal(store?.head(), observedHead, "late result must not write over observation");
      assert.equal((await mailbox.receipt(reply.receipt.id)).attempt, 0, "new reply waits for next dispatch pass");
      const second = await dispatchSpineTreeMailbox({ registry, mailbox, sessions: {
        async request(request) {
          const envelope = JSON.parse(request.text);
          assert.equal(request.targetSessionId, "pi-a");
          assert.equal(envelope.message, "reply");
          await hosts.a.executeTool("spinetree_observe", { receiptId: envelope.receiptId, agentId: "a", leaseId: envelope.leaseId });
          return { accepted: true };
        },
      } });
      assert.deepEqual(second.receipts.map(r => [r.id, r.status]), [[reply.receipt.id, "observed"]]);
      assert.equal((await hosts.a.executeTool("spinetree_send", input)).status, "observed");
      assert.deepEqual(await mailbox.pending(100), []);
      if (store) assert.equal((await new GitSpineTreeMailbox(store.root).receipt(sent.receipt.id)).status, "observed");
    }
  });

  test(`${kind}: observation requires the current delivery identity and old tokens cannot acknowledge takeover`, async t => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { mailbox, hosts } = await fixture(kind, t);
    const queued = (await hosts.a.executeTool("spinetree_send", { to: "b", message: "one" })).receipt;
    const observe = leaseId => hosts.b.executeTool("spinetree_observe", { receiptId: queued.id, agentId: "b", ...(leaseId === undefined ? {} : { leaseId }) });
    await assert.rejects(observe(), { code: "invalid-state" });
    const first = await mailbox.lease(queued.id);
    await assert.rejects(observe(), { code: "lease-conflict" });
    for (const invalid of ["", null, 1]) await assert.rejects(observe(invalid), { code: "invalid-input" });
    now = first.leaseUntil;
    const second = await mailbox.lease(first.id);
    assert.notEqual(second.leaseId, first.leaseId);
    await assert.rejects(observe(first.leaseId), { code: "lease-conflict" });
    await mailbox.delivered(second.id, second.leaseId);
    await assert.rejects(observe(first.leaseId), { code: "lease-conflict" });
    const observed = (await observe(second.leaseId)).receipt;
    assert.deepEqual((await observe()).receipt, observed);
    for (const operation of ["delivered", "release", "fail"]) {
      assert.deepEqual(await mailbox[operation](second.id, second.leaseId, "late"), observed);
      await assert.rejects(async () => mailbox[operation](second.id, first.leaseId, "old"), { code: "lease-conflict" });
    }
    await assert.rejects(observe(first.leaseId), { code: "lease-conflict" });
    const failed = await mailbox.enqueue({ to: "b", from: null, message: "failed" });
    await mailbox.fail(failed.id, (await mailbox.lease(failed.id)).leaseId, "permanent");
    await assert.rejects(async () => mailbox.observed(failed.id), { code: "invalid-state" });
  });
}

test("Git CAS retries a late acknowledgement against an observation committed by another adapter", async t => {
  const { store, mailbox } = await fixture("git", t);
  for (const operation of ["delivered", "release", "fail"]) {
    const queued = await mailbox.enqueue({ to: "b", from: "a", message: operation });
    const leased = await mailbox.lease(queued.id);
    let observedHead;
    let writes = 0;
    const racing = new GitSpineTreeMailbox({
      head: () => store.head(), readSnapshot: head => store.readSnapshot(head),
      async commitSnapshot(head, snapshot, message) {
        ++writes;
        await new GitSpineTreeMailbox(store.root).observed(leased.id, leased.leaseId);
        observedHead = store.head();
        return store.commitSnapshot(head, snapshot, message);
      },
    });
    const result = await racing[operation](leased.id, leased.leaseId, "late");
    assert.equal(result.status, "observed");
    assert.equal(writes, 1, "stale draft must be discarded and replay become write-free");
    assert.equal(store.head(), observedHead);
  }
});

test("legacy delivered receipts without a retained token still allow explicit observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-legacy-observe-"));
  const store = GitSpineTreeStore.initialize(root, { branches: {}, schema: "spinetree.snapshot/v2" });
  const mailbox = new GitSpineTreeMailbox(store);
  const queued = await mailbox.enqueue({ to: "b", from: null, message: "legacy" });
  await mailbox.delivered(queued.id, (await mailbox.lease(queued.id)).leaseId);
  const head = store.head();
  const snapshot = store.readSnapshot(head);
  snapshot.mailbox.receipts[queued.id].leaseId = null;
  store.commitSnapshot(head, snapshot);
  await assert.rejects(mailbox.observed(queued.id, "invented"), { code: "lease-conflict" });
  assert.equal((await mailbox.observed(queued.id)).status, "observed");
});
