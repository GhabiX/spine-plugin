import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitSpineTreeStore, MemorySpineTreeStore, SPINETREE_SNAPSHOT_SCHEMA } from "../dist/index.js";

const initial = () => ({ schema: SPINETREE_SNAPSHOT_SCHEMA, branches: {} });
const invalid = [
  null, [], {}, { branches: {} },
  { schema: "spinetree.snapshot/v1", branches: {} },
  { schema: SPINETREE_SNAPSHOT_SCHEMA, branches: [] },
  { ...initial(), agents: undefined },
  { ...initial(), agents: {} },
  { ...initial(), agents: { legacy: { id: "legacy", working: "root", live: ["root"], status: "running" } } },
];
const invalidSnapshot = { code: "invalid-snapshot" };
const git = (root, args, input) => execFileSync("git", args, { cwd: root, input, encoding: "utf8" }).trim();

test("Memory and Git reject the same legacy and mixed formats before initialization writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-format-init-"));
  for (const [index, value] of invalid.entries()) {
    const before = structuredClone(value);
    const absent = join(directory, `absent-${index}`);
    assert.throws(() => new MemorySpineTreeStore(value), invalidSnapshot);
    assert.throws(() => GitSpineTreeStore.initialize(absent, value), invalidSnapshot);
    assert.equal(existsSync(absent), false);
    const existing = join(directory, `existing-${index}`);
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "existing data");
    assert.throws(() => GitSpineTreeStore.initialize(existing, value), invalidSnapshot);
    assert.deepEqual(await readdir(existing), ["keep.txt"]);
    assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "existing data");
    assert.deepEqual(value, before);
  }
});

for (const kind of ["memory", "git"]) {
  test(`${kind}: invalid commits preserve HEAD, contents and revision sequence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `snapshot-format-${kind}-`));
    const store = kind === "memory" ? new MemorySpineTreeStore(initial()) : GitSpineTreeStore.initialize(directory, initial());
    const head = store.head();
    const objects = kind === "git" ? git(directory, ["count-objects", "-v"]) : null;
    for (const value of invalid) {
      assert.throws(() => store.commitSnapshot(head, value), invalidSnapshot);
      assert.equal(store.head(), head);
      assert.deepEqual(store.readSnapshot(head), initial());
      if (kind === "git") assert.equal(git(directory, ["count-objects", "-v"]), objects);
    }
    const result = store.commitSnapshot(head, { ...initial(), metadata: { source: "accepted" } });
    if (kind === "memory") assert.equal(result.head, "memory-1");
    assert.equal(store.readSnapshot(result.head).metadata.source, "accepted");
  });

  test(`${kind}: accepted snapshots retain registry, mailbox, imports and application metadata`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `snapshot-retain-${kind}-`));
    const snapshot = {
      ...initial(),
      branches: { root: { id: "root", parent: null, goal: "project", constraints: [], skills: [], tools: [],
        memory: null, memoryVersion: 0, memorySource: null, status: "live" } },
      registry: { a: { agentId: "a", sessionId: "s", branch: "root", status: "ended" } },
      mailbox: { receipts: {}, requests: {} }, scopeImports: {}, metadata: { source: "application" },
    };
    const store = kind === "memory" ? new MemorySpineTreeStore(snapshot) : GitSpineTreeStore.initialize(directory, snapshot);
    const before = structuredClone(snapshot), first = store.head();
    snapshot.metadata.source = "caller mutation";
    assert.deepEqual(store.readSnapshot(first), before);
    store.change(first, [{ type: "update", branch: "root", attributes: { goal: "updated" } }]);
    const current = store.readSnapshot(store.head());
    assert.deepEqual(current, { ...before, branches: { root: { ...before.branches.root, goal: "updated", revision: 1 } } });
    if (kind === "git") assert.deepEqual(new GitSpineTreeStore(directory).readSnapshot(store.head()), current);
    current.metadata.source = "reader mutation";
    assert.equal(store.readSnapshot(store.head()).metadata.source, "application");
  });
}

test("opening a legacy Git state does not migrate it or change HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-legacy-"));
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@localhost"]);
  git(directory, ["config", "user.name", "test"]);
  const legacy = { branches: {}, agents: { old: { id: "old", working: "root", live: ["root"], status: "running" } } };
  const raw = JSON.stringify(legacy);
  const blob = git(directory, ["hash-object", "-w", "--stdin"], raw);
  const tree = git(directory, ["mktree"], `100644 blob ${blob}\tstate.json\n`);
  const head = git(directory, ["commit-tree", tree, "-m", "legacy fixture"]);
  git(directory, ["update-ref", "HEAD", head]);
  const objects = git(directory, ["count-objects", "-v"]);
  const store = new GitSpineTreeStore(directory);
  assert.throws(() => store.readSnapshot(head), invalidSnapshot);
  assert.throws(() => store.change(head, []), invalidSnapshot);
  assert.equal(store.head(), head);
  assert.equal(git(directory, ["show", `${head}:state.json`]), raw);
  assert.equal(git(directory, ["count-objects", "-v"]), objects);
});
