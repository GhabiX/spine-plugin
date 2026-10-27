import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GitSpineTreeAgentRegistry,
  GitSpineTreeMailbox,
  GitSpineTreeStore,
  SpineTreeMailboxError,
} from "../dist/index.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));
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
      status: "capped",
    },
  },
  schema: "spinetree.snapshot/v2",
};

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(path) {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await delay(5);
    }
  }
}

function runChild(script, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${error || output}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (parseError) {
        reject(new Error(`child returned invalid JSON: ${parseError.message}; stdout=${output}; stderr=${error}`));
      }
    });
  });
}

const leaseRaceScript = `
  import { writeFile, access } from "node:fs/promises";
  import { join } from "node:path";
  import { GitSpineTreeMailbox } from "./dist/index.js";
  const wait = async path => { for (;;) { try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } } };
  const mailbox = new GitSpineTreeMailbox(process.env.SPINE_ROOT);
  await writeFile(join(process.env.SPINE_BARRIER, "ready-" + process.env.SPINE_ROLE), "");
  await wait(join(process.env.SPINE_BARRIER, "release"));
  try {
    const receipt = await mailbox.lease("mail-1");
    process.stdout.write(JSON.stringify({ ok: true, leaseId: receipt.leaseId, attempt: receipt.attempt }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, name: error.name, code: error.code, message: error.message }));
  }
`;

const registryRaceScript = `
  import { writeFile, access } from "node:fs/promises";
  import { join } from "node:path";
  import { GitSpineTreeAgentRegistry } from "./dist/index.js";
  const wait = async path => { for (;;) { try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } } };
  const registry = new GitSpineTreeAgentRegistry(process.env.SPINE_ROOT);
  await writeFile(join(process.env.SPINE_BARRIER, "ready-" + process.env.SPINE_ROLE), "");
  await wait(join(process.env.SPINE_BARRIER, "release"));
  try {
    await registry.registerExclusive({
      agentId: "agent-" + process.env.SPINE_ROLE,
      sessionId: "session-" + process.env.SPINE_ROLE,
      branch: "root",
      status: "running",
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, name: error.name, code: error.code, message: error.message }));
  }
`;

test("Git mailbox gives exactly one winner when two processes lease the same receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-cross-lease-race-"));
  const barrier = await mkdtemp(join(tmpdir(), "spinetree-cross-lease-barrier-"));
  const store = GitSpineTreeStore.initialize(root, snapshot);
  const mailbox = new GitSpineTreeMailbox(store);
  await mailbox.enqueue({ to: "agent", from: null, message: "race" });

  const first = runChild(leaseRaceScript, { SPINE_ROOT: root, SPINE_BARRIER: barrier, SPINE_ROLE: "first" });
  const second = runChild(leaseRaceScript, { SPINE_ROOT: root, SPINE_BARRIER: barrier, SPINE_ROLE: "second" });
  await Promise.all([waitFor(join(barrier, "ready-first")), waitFor(join(barrier, "ready-second"))]);
  await writeFile(join(barrier, "release"), "");
  const results = await Promise.all([first, second]);

  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ["lease-conflict"]);
  const winner = results.find(result => result.ok);
  assert.equal(winner.attempt, 1);
  assert.equal((await mailbox.receipt("mail-1")).leaseId, winner.leaseId);
});

test("Git mailbox cross-process takeover invalidates the old lease token", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-cross-lease-takeover-"));
  const store = GitSpineTreeStore.initialize(root, snapshot);
  const mailbox = new GitSpineTreeMailbox(store);
  await mailbox.enqueue({ to: "agent", from: null, message: "takeover" });
  const oldLease = await mailbox.lease("mail-1");
  const head = store.head();
  const current = store.readSnapshot(head);
  store.commitSnapshot(head, {
    ...current,
    mailbox: {
      ...current.mailbox,
      receipts: {
        ...current.mailbox.receipts,
        "mail-1": { ...oldLease, leaseUntil: Date.now() - 1 },
      },
    },
  }, "test: expire lease");

  const result = await runChild(`
    import { GitSpineTreeMailbox } from "./dist/index.js";
    const receipt = await new GitSpineTreeMailbox(process.env.SPINE_ROOT).lease("mail-1");
    process.stdout.write(JSON.stringify({ leaseId: receipt.leaseId, attempt: receipt.attempt }));
  `, { SPINE_ROOT: root });
  assert.equal(result.attempt, 2);
  assert.notEqual(result.leaseId, oldLease.leaseId);
  await assert.rejects(
    mailbox.delivered("mail-1", oldLease.leaseId),
    error => error instanceof SpineTreeMailboxError && error.code === "lease-conflict",
  );
  assert.equal((await mailbox.receipt("mail-1")).leaseId, result.leaseId);
});

test("Git registry exclusive registration has one cross-process branch owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "spinetree-cross-registry-race-"));
  const barrier = await mkdtemp(join(tmpdir(), "spinetree-cross-registry-barrier-"));
  GitSpineTreeStore.initialize(root, snapshot);

  const first = runChild(registryRaceScript, { SPINE_ROOT: root, SPINE_BARRIER: barrier, SPINE_ROLE: "first" });
  const second = runChild(registryRaceScript, { SPINE_ROOT: root, SPINE_BARRIER: barrier, SPINE_ROLE: "second" });
  await Promise.all([waitFor(join(barrier, "ready-first")), waitFor(join(barrier, "ready-second"))]);
  await writeFile(join(barrier, "release"), "");
  const results = await Promise.all([first, second]);

  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ["branch-occupied"]);
  const registry = new GitSpineTreeAgentRegistry(root);
  const owners = await registry.list("root");
  assert.equal(owners.length, 1);
  assert.equal(owners[0].status, "running");
});
