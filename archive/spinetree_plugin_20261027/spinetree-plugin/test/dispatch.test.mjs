import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchSpineTreeMailbox,
  GitSpineTreeAgentRegistry,
  GitSpineTreeMailbox,
  GitSpineTreeStore,
  MemoryAgentRegistry,
  MemorySpineTreeMailbox,
  MemorySpineTreeStore,
  SpineTreeMailboxError,
} from "../dist/index.js";

const snapshot = { branches: {}, schema: "spinetree.snapshot/v2" };
const binding = { agentId: "agent", sessionId: "session", branch: "root", status: "running" };
const input = message => ({ to: "agent", from: null, message });
const ids = receipts => receipts.map(receipt => receipt.id);
const leaseConflict = error => error instanceof SpineTreeMailboxError && error.code === "lease-conflict";

async function fixture(kind) {
  if (kind === "memory") return { mailbox: new MemorySpineTreeMailbox() };
  const root = await mkdtemp(join(tmpdir(), "spinetree-dispatch-"));
  const store = GitSpineTreeStore.initialize(root, snapshot);
  return { root, store, mailbox: new GitSpineTreeMailbox(store) };
}

function registry() {
  const value = new MemoryAgentRegistry();
  value.register(binding);
  return value;
}

for (const kind of ["memory", "git"]) {
  test(`${kind} pending is read-only, bounded and reclaims expired leases with fresh tokens`, async t => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { mailbox, store } = await fixture(kind);
    const queued = await mailbox.enqueue(input("queued"));
    const expired = await mailbox.lease((await mailbox.enqueue(input("expired"))).id);
    const delivered = await mailbox.enqueue(input("delivered"));
    await mailbox.delivered(delivered.id, (await mailbox.lease(delivered.id)).leaseId);
    const observed = await mailbox.enqueue(input("observed"));
    await mailbox.delivered(observed.id, (await mailbox.lease(observed.id)).leaseId);
    await mailbox.observed(observed.id);
    const failed = await mailbox.enqueue(input("failed"));
    await mailbox.fail(failed.id, (await mailbox.lease(failed.id)).leaseId, "permanent");
    now = 2_000;
    await mailbox.lease((await mailbox.enqueue(input("live"))).id);
    now = expired.leaseUntil;
    const head = store?.head();
    const pending = await mailbox.pending(10);
    assert.deepEqual(ids(pending), [queued.id, expired.id]);
    assert.deepEqual(ids(await mailbox.pending(1)), [queued.id]);
    pending[0].message = "detached";
    assert.equal((await mailbox.receipt(queued.id)).message, "queued");
    assert.equal(store?.head(), head);
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(async () => mailbox.pending(limit), TypeError);
    }
    const reclaimed = await mailbox.lease(expired.id);
    assert.notEqual(reclaimed.leaseId, expired.leaseId);
    assert.equal(reclaimed.attempt, 2);
    await assert.rejects(async () => mailbox.delivered(expired.id, expired.leaseId), leaseConflict);
    assert.deepEqual(ids(await mailbox.pending(10)), [queued.id]);
  });

  test(`${kind} competing dispatchers use the same selection but only one acquires its lease`, async () => {
    const { mailbox, store } = await fixture(kind);
    const other = store ? new GitSpineTreeMailbox(new GitSpineTreeStore(store.root)) : mailbox;
    const receipt = await mailbox.enqueue(input("one"));
    const selected = Promise.withResolvers();
    let selections = 0;
    for (const candidate of new Set([mailbox, other])) {
      const pending = candidate.pending.bind(candidate);
      candidate.pending = async limit => {
        const result = await pending(limit);
        if (++selections === 2) selected.resolve();
        await selected.promise;
        return result;
      };
    }
    const requests = [];
    const sessions = { async request(request) { requests.push(request); return { accepted: true }; } };
    const results = await Promise.all([mailbox, other].map(mailbox =>
      dispatchSpineTreeMailbox({ registry: registry(), mailbox, sessions })));
    assert.deepEqual(results.flatMap(result => ids(result.receipts)), [receipt.id]);
    assert.deepEqual(results.flatMap(result => result.skipped), [receipt.id]);
    assert.equal(requests.length, 1);
    assert.equal((await mailbox.receipt(receipt.id)).status, "delivered");
    assert.equal((await mailbox.receipt(receipt.id)).attempt, 1);
  });
}

test("Git pending captures one HEAD and time, and defers future retries without writing", async t => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const store = new MemorySpineTreeStore(snapshot);
  const mailbox = new GitSpineTreeMailbox(store);
  const receipt = await mailbox.enqueue(input("later"));
  const head = store.head();
  const state = store.readSnapshot(head);
  state.mailbox.receipts[receipt.id].nextAttemptAt = 2_000;
  store.commitSnapshot(head, state);
  const captured = store.head();
  const calls = [];
  const reader = new GitSpineTreeMailbox({
    head() { calls.push("head"); return captured; },
    readSnapshot(head) { calls.push(head); now = 3_000; return store.readSnapshot(head); },
    commitSnapshot() { assert.fail("selection must not write"); },
  });
  assert.deepEqual(await reader.pending(10), []);
  assert.deepEqual(calls, ["head", captured]);
  assert.equal(store.head(), captured);
  now = 1_999;
  await assert.rejects(mailbox.lease(receipt.id), leaseConflict);
  now = 2_000;
  assert.deepEqual(ids(await mailbox.pending(10)), [receipt.id]);
});

test("dispatch attempts a bounded selection once and leaves new messages for the next pass", async () => {
  const mailbox = new MemorySpineTreeMailbox();
  const agents = registry();
  agents.register({ ...binding, agentId: "ended", status: "ended" });
  agents.register({ ...binding, agentId: "paused", status: "paused" });
  for (const message of ["reject", "transient", "permanent", "ok"]) mailbox.enqueue(input(message));
  mailbox.enqueue({ ...input("unknown"), to: "unknown" });
  mailbox.enqueue({ ...input("ended"), to: "ended" });
  mailbox.enqueue({ ...input("paused"), to: "paused" });
  const calls = [];
  const sessions = { async request(request) {
    calls.push(request);
    if (JSON.parse(request.text).message === "reject") {
      mailbox.enqueue(input("added during dispatch"));
      return { accepted: false };
    }
    if (JSON.parse(request.text).message === "transient") throw new Error("disconnected");
    if (JSON.parse(request.text).message === "permanent") throw Object.assign(new Error("invalid target"), { permanent: true });
    return { accepted: true };
  } };
  const first = await dispatchSpineTreeMailbox({ registry: agents, mailbox, sessions, limit: 3 });
  assert.deepEqual(first.receipts.map(receipt => [receipt.status, receipt.attempt, receipt.lastError]), [
    ["queued", 1, "session request was not accepted"], ["queued", 1, "disconnected"], ["failed", 1, "invalid target"],
  ]);
  assert.equal(calls.length, 3);
  assert.equal(mailbox.receipt("mail-4").attempt, 0);
  assert.equal(mailbox.receipt("mail-8").attempt, 0);
  const second = await dispatchSpineTreeMailbox({ registry: agents, mailbox, sessions: {
    async request(request) { calls.push(request); return { accepted: true }; },
  } });
  assert.deepEqual(second.receipts.map(receipt => receipt.status), [
    "delivered", "delivered", "delivered", "failed", "failed", "delivered", "delivered",
  ]);
  assert.equal(second.receipts[0].attempt, 2);
  assert.deepEqual(calls[0], { targetSessionId: "session", operation: "prompt", text: JSON.stringify({ schema: "spinetree.message/v1", receiptId: "mail-1", leaseId: "lease-1", to: "agent", from: null, message: "reject" }), requestId: "mail-1" });
  assert.equal(calls.some(request => ["unknown", "ended"].includes(JSON.parse(request.text).message)), false);
  assert.deepEqual(await mailbox.pending(100), []);
});

test("a fresh process dispatches persisted queued and abandoned leased receipts without sender replay", async t => {
  const { root, store, mailbox } = await fixture("git");
  await new GitSpineTreeAgentRegistry(store).register(binding);
  await mailbox.enqueue({ ...input("queued"), requestId: "caller-1" });
  const abandoned = await mailbox.enqueue({ ...input("abandoned"), requestId: "caller-2" });
  const date = t.mock.method(Date, "now", () => 1_000);
  await mailbox.lease(abandoned.id);
  date.mock.restore();
  const script = `
    import { GitSpineTreeMailbox, GitSpineTreeAgentRegistry, dispatchSpineTreeMailbox } from './dist/index.js';
    const calls = [];
    const result = await dispatchSpineTreeMailbox({
      mailbox: new GitSpineTreeMailbox(process.env.SPINE_ROOT),
      registry: new GitSpineTreeAgentRegistry(process.env.SPINE_ROOT),
      sessions: { async request(request) { calls.push(request); return { accepted: true }; } },
    });
    process.stdout.write(JSON.stringify({ result, calls }));
  `;
  const output = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SPINE_ROOT: root }, encoding: "utf8",
  }));
  assert.deepEqual(output.result.receipts.map(receipt => [receipt.status, receipt.attempt]), [["delivered", 1], ["delivered", 2]]);
  assert.deepEqual(output.calls.map(request => [JSON.parse(request.text).message, request.requestId]), [["queued", "mail-1"], ["abandoned", "mail-2"]]);
  const reloaded = new GitSpineTreeMailbox(root);
  assert.deepEqual(await reloaded.pending(10), []);
  assert.equal((await reloaded.enqueue({ ...input("queued"), requestId: "caller-1" })).status, "delivered");
  assert.equal((await reloaded.receipt("mail-2")).status, "delivered");
});

test("dispatch propagates infrastructure errors and leaves acquired leases recoverable", async t => {
  const mailbox = new MemorySpineTreeMailbox();
  const receipt = mailbox.enqueue(input("pending"));
  const failure = new Error("storage offline");
  const sessions = { async request() { assert.fail("no transport before a valid lease and registry lookup"); } };
  for (const error of [failure, new SpineTreeMailboxError("unknown-receipt", "missing")]) {
    const mock = t.mock.method(mailbox, "lease", () => { throw error; });
    await assert.rejects(dispatchSpineTreeMailbox({ registry: registry(), mailbox, sessions }), actual => actual === error);
    mock.mock.restore();
  }
  const agents = registry();
  t.mock.method(agents, "resolve", () => { throw failure; });
  await assert.rejects(dispatchSpineTreeMailbox({ registry: agents, mailbox, sessions }), actual => actual === failure);
  assert.equal(mailbox.receipt(receipt.id).status, "queued");
  assert.equal(mailbox.receipt(receipt.id).attempt, 0);
  for (const limit of [0, -1, 0.5, Infinity]) {
    await assert.rejects(dispatchSpineTreeMailbox({ registry: agents, mailbox, sessions, limit }), TypeError);
  }
});

test("dispatch propagates acknowledgement storage failure without requeuing accepted delivery", async t => {
  const mailbox = new MemorySpineTreeMailbox();
  const failure = new Error("ack write failed");
  t.mock.method(mailbox, "delivered", () => { throw failure; });
  t.mock.method(mailbox, "release", () => { assert.fail("ack failure is not a transport rejection"); });
  mailbox.enqueue(input("one"));
  await assert.rejects(dispatchSpineTreeMailbox({ registry: registry(), mailbox,
    sessions: { async request() { return { accepted: true }; } },
  }), error => error === failure);
  assert.equal(mailbox.receipt("mail-1").status, "leased");
});

test("a late transport completion cannot overwrite a newer lease's delivered receipt", async t => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const mailbox = new MemorySpineTreeMailbox();
  mailbox.enqueue(input("one"));
  const started = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const first = dispatchSpineTreeMailbox({ registry: registry(), mailbox, sessions: {
    async request() { started.resolve(); return completed.promise; },
  } });
  await started.promise;
  now += 30_000;
  await dispatchSpineTreeMailbox({ registry: registry(), mailbox, sessions: { async request() { return { accepted: true }; } } });
  const winner = mailbox.receipt("mail-1");
  assert.equal(winner.attempt, 2);
  completed.resolve({ accepted: true });
  await assert.rejects(first, leaseConflict);
  assert.deepEqual(mailbox.receipt("mail-1"), winner);
  assert.equal(winner.status, "delivered");
});

test("dispatch fails closed when the recipient WorkingBinding changes before acknowledgement", async () => {
  const mailbox = new MemorySpineTreeMailbox();
  mailbox.enqueue(input("one"));
  const first = { ...binding, bindingId: "binding-1", sessionId: "session-1" };
  const replaced = { ...first, bindingId: "binding-2", sessionId: "session-2" };
  let seen = false;
  await assert.rejects(dispatchSpineTreeMailbox({
    registry: {
      async resolve() {
        if (seen) return replaced;
        seen = true;
        return first;
      },
    },
    mailbox,
    sessions: { async request() { return { accepted: true }; } },
  }), leaseConflict);
  assert.equal(mailbox.receipt("mail-1").status, "leased");
  assert.equal(mailbox.receipt("mail-1").bindingId, "binding-1");
});

test("a replaced WorkingBinding cannot observe or complete the previous delivery lease", async () => {
  const mailbox = new MemorySpineTreeMailbox();
  mailbox.enqueue(input("one"));
  mailbox.enqueue(input("two"));
  const first = mailbox.lease("mail-1", { agentId: "agent", sessionId: "session-1", bindingId: "binding-1" });
  const second = mailbox.lease("mail-2", { agentId: "agent", sessionId: "session-1", bindingId: "binding-1" });
  await assert.rejects(async () => mailbox.observed(first.id, first.leaseId, "binding-2"), leaseConflict);
  await assert.rejects(async () => mailbox.delivered(second.id, second.leaseId, "binding-2"), leaseConflict);
  assert.equal(mailbox.observed(first.id, first.leaseId, "binding-1").status, "observed");
});
