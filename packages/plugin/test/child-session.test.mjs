import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spineChildAssignmentText } from "@spinejit/spine-sdk/host";

import {
  buildChildContinuation,
  childSessionPath,
  inspectChildSession,
  latestChildSession,
  readChildSessionIdentity,
  readChildState,
  writeChildPrefixSession,
} from "../dist/pi/child-session.js";
import { arrivalMessage } from "../dist/pi/messages.js";
import { spawnAcceptedDetails } from "../dist/pi/spawn-view.js";

test("written prefix session is a Pi-openable fork of the parent branch", async () => {
  const dest = join(await mkdtemp(join(tmpdir(), "pi-spine-prefix-")), "child.jsonl");
  const entries = [
    {
      type: "message",
      id: "aaaaaaaa",
      parentId: null,
      timestamp: "2026-09-17T12:00:00.000Z",
      message: { role: "user", content: "parent prefix TOKEN", timestamp: 1 },
    },
  ];
  const id = await writeChildPrefixSession({
    cwd: "/tmp/project",
    destPath: dest,
    entries,
    parentSession: "/tmp/parent.jsonl",
  });
  assert.equal(await readChildSessionIdentity(dest), id);
  const raw = await readFile(dest, "utf8");
  assert.match(raw, /"parentSession":"\/tmp\/parent.jsonl"/);
  const session = SessionManager.open(dest, undefined, "/tmp/project");
  const branch = session.getBranch();
  assert.equal(branch.length, 1);
  assert.equal(branch[0].type, "message");
  assert.equal(branch[0].message.content, "parent prefix TOKEN");
});

test("child session path is keyed by parent session, birth entry and birth id, next to the parent file", () => {
  assert.equal(
    childSessionPath({ parentSessionId: "parent-1", parentSessionFile: "/tmp/sessions/parent.jsonl" }, { origin: "a1b2c3d4", producer: [0, 2, 1] }),
    "/tmp/sessions/spine-spawn/parent-1/a1b2c3d4.0.2.1.jsonl",
  );
  assert.match(
    childSessionPath({ parentSessionId: "parent/1" }, { origin: "e1", producer: [0, 3] }),
    /pi-spine-spawn\/parent_1\/e1\.0\.3\.jsonl$/,
  );
  assert.match(
    childSessionPath({ parentSessionId: "parent-1" }, { origin: "e1", producer: [0, 3] }, 1),
    /pi-spine-spawn\/parent-1\/e1\.0\.3\.attempt-1\.jsonl$/,
  );
});

test("a child's latest session is its newest attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-spine-latest-"));
  const scope = { parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl") };
  const birth = { origin: "e7", producer: [0, 1] };
  assert.equal(await latestChildSession(scope, birth), null);
  const first = childSessionPath(scope, birth);
  await writeChildPrefixSession({ cwd: "/tmp/project", destPath: first, entries: [] });
  assert.deepEqual(await latestChildSession(scope, birth), { path: first, attempt: 0 });
  const retry = childSessionPath(scope, birth, 1);
  await writeChildPrefixSession({ cwd: "/tmp/project", destPath: retry, entries: [] });
  assert.deepEqual(await latestChildSession(scope, birth), { path: retry, attempt: 1 });
  // A sibling whose id extends this one, or the same id born on another branch, is a different child.
  assert.equal(await latestChildSession(scope, { origin: "e7", producer: [0] }), null);
  assert.equal(await latestChildSession(scope, { origin: "e8", producer: [0, 1] }), null);
});

const message = (id, value) => ({ type: "message", id, timestamp: "2026-11-04T12:00:00.000Z", message: value });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 });
const spawnCall = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "spine_spawn", arguments: {} }], stopReason: "toolUse", timestamp: 2 });
const spawnResult = (id, tasks) => ({
  role: "toolResult", toolCallId: id, toolName: "spine_spawn", content: [{ type: "text", text: "accepted" }],
  details: spawnAcceptedDetails(tasks), isError: false, timestamp: 3,
});
const arrival = (id, producer) => {
  const { role: _role, ...custom } = arrivalMessage({ producer, outcome: "completed", memory: "m" });
  return { type: "custom_message", id, timestamp: "2026-11-04T12:00:00.000Z", ...custom };
};

/** A child session as Pi writes it: one chain of entries, the prefix first. */
async function childFile(prefix, own) {
  const chain = (entries, parentId) => entries.map((entry, index) => ({ ...entry, parentId: index === 0 ? parentId : entries[index - 1].id }));
  const path = join(await mkdtemp(join(tmpdir(), "pi-spine-end-")), "child.jsonl");
  const written = chain(prefix, null);
  await writeChildPrefixSession({ cwd: "/tmp/project", destPath: path, entries: written });
  await appendFile(path, chain(own, written.at(-1)?.id ?? null).map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

test("a child's end is read from what it wrote after its birth prefix", async () => {
  // The parent's own Spawn is unarrived in the prefix: its births are the parent's to join.
  const prefix = [
    message("p1", user("request")),
    message("p2", spawnCall("spawn-p")),
    message("p3", spawnResult("spawn-p", [{ summary: "X", prompt: "x" }])),
    message("p4", reply("parent reply")),
  ];
  const ended = [message("c1", user("assignment")), message("c2", reply("child result"))];
  const completed = { open: 0, terminal: { outcome: "completed", memory: "child result" } };
  assert.deepEqual(readChildState(await childFile(prefix, ended)), completed);
  // Pi may compact after the last reply: the summary is bookkeeping, not a message of the child's.
  const compaction = { type: "compaction", id: "c3", timestamp: "2026-11-04T12:00:00.000Z", summary: "s", firstKeptEntryId: "c1", tokensBefore: 100 };
  assert.deepEqual(readChildState(await childFile(prefix, [...ended, compaction])), completed);
  // A child that wrote nothing has not ended, whatever its prefix ends with.
  assert.deepEqual(readChildState(await childFile(prefix, [])), { open: 0, terminal: null });
});

test("a child that stops before its own children arrive has not ended", async () => {
  const tasks = [{ summary: "X1", prompt: "a" }, { summary: "X2", prompt: "b" }];
  const own = [message("c1", user("assignment")), message("c2", spawnCall("spawn-c")), message("c3", spawnResult("spawn-c", tasks)), message("c4", reply("waiting"))];
  assert.deepEqual(readChildState(await childFile([], own)), { open: 2, terminal: null });
  const arrived = [...own, arrival("c5", [1, 1]), arrival("c6", [1, 2]), message("c7", reply("X1 and X2 done"))];
  assert.deepEqual(readChildState(await childFile([], arrived)), { open: 0, terminal: { outcome: "completed", memory: "X1 and X2 done" } });
});

test("child continuation preserves the active session and optional guidance", () => {
  const prompt = buildChildContinuation("focus on the failing test");
  assert.match(prompt, /same active branch/);
  assert.match(prompt, /focus on the failing test/);
  assert.match(prompt, /end with a final reply that holds the complete terminal memory/);
});

test("child session inspection detects durable assignment context", async () => {
  const dest = join(await mkdtemp(join(tmpdir(), "pi-spine-inspect-")), "child.jsonl");
  const assignment = spineChildAssignmentText(
    { summary: "ALPHA", prompt: "return TOKEN_A" },
    [{ summary: "ALPHA", prompt: "return TOKEN_A" }],
  );
  const id = await writeChildPrefixSession({
    cwd: "/tmp/project",
    destPath: dest,
    entries: [],
  });
  const headerOnly = await inspectChildSession({
    cwd: "/tmp/project",
    destPath: dest,
    expectedId: id,
    assignment,
  });
  assert.equal(headerOnly.assignmentPresent, false);

  const session = SessionManager.open(dest, undefined, "/tmp/project");
  session.appendMessage({ role: "user", content: assignment, timestamp: Date.now() });
  const durable = await inspectChildSession({
    cwd: "/tmp/project",
    destPath: dest,
    expectedId: id,
    assignment,
  });
  assert.equal(durable.assignmentPresent, true);
  await assert.rejects(
    inspectChildSession({
      cwd: "/tmp/project",
      destPath: dest,
      expectedId: "wrong-session-id",
      assignment,
    }),
    /identity changed/,
  );
});

test("child continuation includes assignment only for the missing-context fallback", () => {
  const assignment = "Assignment:\nreturn TOKEN_A";
  const normal = buildChildContinuation();
  const fallback = buildChildContinuation(undefined, assignment);
  assert.doesNotMatch(normal, /Assignment context:/);
  assert.match(fallback, /Assignment context:/);
  assert.match(fallback, /return TOKEN_A/);
});
