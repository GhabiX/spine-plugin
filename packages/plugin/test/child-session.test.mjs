import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spineChildAssignmentText } from "@spinejit/spine-sdk/host";

import {
  buildChildContinuation,
  acceptedChildReturns,
  childSessionPath,
  inspectChildSession,
  readChildReturn,
  readChildSessionIdentity,
  writeChildPrefixSession,
} from "../dist/pi/child-session.js";

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

test("a child's typed return is read back from its own session across attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-spine-return-"));
  const scope = { parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl") };
  const birth = { origin: "e7", producer: [0, 1] };
  assert.deepEqual(await readChildReturn(scope, birth), { memory: null, latest: null });

  const first = childSessionPath(scope, birth);
  await writeChildPrefixSession({ cwd: "/tmp/project", destPath: first, entries: [] });
  assert.deepEqual(await readChildReturn(scope, birth), { memory: null, latest: { path: first, attempt: 0 } });

  const retry = childSessionPath(scope, birth, 1);
  await writeChildPrefixSession({ cwd: "/tmp/project", destPath: retry, entries: [] });
  const session = SessionManager.open(retry, undefined, "/tmp/project");
  session.appendMessage({ role: "user", content: "assignment", timestamp: 1 });
  for (const message of returnEntries("child result")) session.appendMessage(message);
  assert.deepEqual(await readChildReturn(scope, birth), { memory: "child result", latest: { path: retry, attempt: 1 } });
  // A sibling whose id extends this one, or the same id born on another branch, is a different child.
  assert.deepEqual(await readChildReturn(scope, { origin: "e7", producer: [0] }), { memory: null, latest: null });
  assert.deepEqual(await readChildReturn(scope, { origin: "e8", producer: [0, 1] }), { memory: null, latest: null });
});

test("only a return call whose own tool result succeeded is the child's typed return", () => {
  const jsonl = (messages) => messages.map((message) => JSON.stringify({ type: "message", message })).join("\n");
  const [call, result] = returnEntries("child result");
  assert.deepEqual(acceptedChildReturns(`not-json\n${jsonl([call, result])}`), ["child result"]);
  // The child's admission blocked the call: Pi records an error result.
  assert.deepEqual(acceptedChildReturns(jsonl(returnEntries("too early", true))), []);
  // A call without a result, or a result for another call, returns nothing.
  assert.deepEqual(acceptedChildReturns(jsonl([call])), []);
  assert.deepEqual(acceptedChildReturns(jsonl([call, { ...result, toolCallId: "other" }])), []);
  assert.deepEqual(acceptedChildReturns(jsonl([call, result, call, result])), ["child result", "child result"]);
});

/** A child's typed return as Pi records it: the call, then its tool result. */
function returnEntries(memory, isError = false) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "return-1", name: "spine_child_return", arguments: { memory } }],
      api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "return-1",
      toolName: "spine_child_return",
      content: [{ type: "text", text: isError ? "blocked" : "Spine child memory accepted" }],
      isError,
      timestamp: 3,
    },
  ];
}


test("child continuation preserves the active session and optional guidance", () => {
  const prompt = buildChildContinuation("focus on the failing test");
  assert.match(prompt, /same active branch/);
  assert.match(prompt, /focus on the failing test/);
  assert.match(prompt, /spine_child_return exactly once/);
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
