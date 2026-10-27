import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitSpineTreeStore } from "../dist/index.js";

async function fixture() {
  const temporary = process.env.SPINETREE_TEST_TEMP ?? resolve("temp/null/20260928_1700/git-ref-lock");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "store-"));
  const store = GitSpineTreeStore.initialize(root, {
    schema: "spinetree.snapshot/v2", branches: {
      root: { id: "root", parent: null, goal: "initial", status: "live", constraints: [],
        skills: [], tools: [], memory: null, memoryVersion: 0, memorySource: null },
    },
  });
  return { root, store, head: store.head() };
}

async function holdRef(t, root) {
  // Git 2.25 lacks interactive ref-transaction commands; hold the real HEAD
  // lock path to exercise update-ref's lock acquisition behavior.
  const lock = join(root, ".git", "HEAD.lock");
  await writeFile(lock, "fixture owns this lock\n", { flag: "wx" });
  const recycleRoot = resolve("temp/recyclebin/20260928_1700/git-ref-lock");
  await mkdir(recycleRoot, { recursive: true });
  const recycle = await mkdtemp(join(recycleRoot, "lock-"));
  let released = false;
  async function release(action, newHead) {
    if (released) return;
    if (action === "publish") {
      assert.match(newHead, /^[0-9a-f]{40}$/);
      await writeFile(lock, `${newHead}\n`);
      await rename(lock, join(root, ".git", "HEAD"));
    } else {
      await rename(lock, join(recycle, "HEAD.lock"));
    }
    released = true;
  }
  t.after(() => release("abort"));
  return release;
}

async function startWriter(t, root, head) {
  const script = `
    import { GitSpineTreeStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const store = new GitSpineTreeStore(process.env.SPINETREE_LOCK_ROOT);
    const head = process.env.SPINETREE_LOCK_HEAD;
    const snapshot = store.readSnapshot(head);
    snapshot.branches.root.goal = 'writer';
    process.send({ phase: 'starting' });
    process.once('message', () => {
      try { process.send({ result: store.commitSnapshot(head, snapshot) }); }
      catch (error) { process.send({ error: { name: error.name, code: error.code, message: error.message } }); }
      process.disconnect();
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, SPINETREE_LOCK_ROOT: root, SPINETREE_LOCK_HEAD: head },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "", answer;
  child.stderr.on("data", chunk => { stderr += chunk; });
  const ready = new Promise(resolve => child.once("message", resolve));
  child.on("message", message => { if (message.phase !== "starting") answer = message; });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject); child.on("exit", code => resolve(code));
  });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; });
  assert.deepEqual(await ready, { phase: "starting" });
  child.send("commit");
  return async () => { assert.equal(await exited, 0, stderr); assert.ok(answer); return answer; };
}

test("Git publication waits for a transient ref lock without changing expected HEAD", { timeout: 15000 }, async t => {
  const f = await fixture();
  const release = await holdRef(t, f.root);
  const result = await startWriter(t, f.root, f.head);
  await new Promise(resolve => setTimeout(resolve, 400));
  await release("abort");
  const answer = await result();
  assert.equal(answer.error, undefined);
  assert.equal(answer.result.parent, f.head);
  assert.equal(f.store.head(), answer.result.head);
  assert.equal(f.store.readSnapshot(f.store.head()).branches.root.goal, "writer");
});

test("a ref lock that outlasts the bounded wait fails without publishing", { timeout: 15000 }, async t => {
  const f = await fixture();
  const release = await holdRef(t, f.root);
  const result = await startWriter(t, f.root, f.head);
  const started = Date.now();
  const answer = await result();
  const elapsed = Date.now() - started;
  assert.equal(answer.error?.code, "git-error");
  assert.ok(elapsed >= 700 && elapsed < 5000, `lock wait was ${elapsed}ms`);
  assert.equal(f.store.head(), f.head);
  assert.equal(f.store.readSnapshot(f.head).branches.root.goal, "initial");
  await release("abort");
});

test("waiting for a ref lock cannot overwrite a competing HEAD publication", { timeout: 15000 }, async t => {
  const f = await fixture();
  const winner = f.store.commitSnapshot(f.head, { ...f.store.readSnapshot(f.head), metadata: "winner" }).head;
  execFileSync("git", ["update-ref", "HEAD", f.head, winner], { cwd: f.root });
  const release = await holdRef(t, f.root);
  const result = await startWriter(t, f.root, f.head);
  await new Promise(resolve => setTimeout(resolve, 400));
  await release("publish", winner);
  const answer = await result();
  assert.equal(answer.error?.code, "stale-head");
  assert.equal(f.store.head(), winner);
  assert.equal(f.store.readSnapshot(winner).metadata, "winner");
  assert.equal(f.store.readSnapshot(winner).branches.root.goal, "initial");
});
