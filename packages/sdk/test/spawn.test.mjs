import assert from "node:assert/strict";
import test from "node:test";

import { childState, runSpawnChild, toArrival } from "../dist/host/spawn.js";

const task = { summary: "child", prompt: "do the work" };

function scripted(...terminals) {
  const calls = [];
  return {
    calls,
    executor: {
      async execute(_task, context) {
        calls.push({ attempt: context.attempt, mode: context.mode, guidance: context.guidance });
        const next = terminals.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const reply = (text) => ({ type: "reply", text });
const other = { type: "other" };

test("a child's last reply is the memory it returns; a last failed request, its error", () => {
  assert.deepEqual(childState([other, reply("draft"), other, reply("final")]), {
    open: 0, terminal: { outcome: "completed", memory: "final" },
  });
  assert.deepEqual(childState([other, { type: "error", message: "403 insufficient balance" }]), {
    open: 0, terminal: { outcome: "errored", diagnostic: "403 insufficient balance" },
  });
});

test("a child has not ended while a child of its own has not arrived", () => {
  const log = [other, { type: "spawn", births: 2 }, reply("waiting"), { type: "arrival" }, reply("one in")];
  assert.deepEqual(childState(log), { open: 1, terminal: null });
  assert.deepEqual(childState([...log, { type: "arrival" }, reply("both in")]), {
    open: 0, terminal: { outcome: "completed", memory: "both in" },
  });
});

test("a child has not ended while its log ends on anything but a reply or an error", () => {
  assert.deepEqual(childState([]), { open: 0, terminal: null });
  assert.deepEqual(childState([reply("done"), other]), { open: 0, terminal: null });
});

test("a completed child arrives with its memory and nothing else", async () => {
  const { executor } = scripted({ outcome: "completed", memory: "done", executionRef: "ref-1" });
  const arrival = await runSpawnChild({ producer: [0, 2], task, executor, signal: new AbortController().signal });
  assert.deepEqual(arrival, { producer: [0, 2], outcome: "completed", memory: "done", execution_ref: "ref-1" });
});

test("a failed child arrives with a diagnostic and no memory", async () => {
  const { executor } = scripted({ outcome: "errored", memory: "partial", diagnostic: "exit 2" });
  const arrival = await runSpawnChild({ producer: [0, 2], task, executor, signal: new AbortController().signal });
  assert.deepEqual(arrival, { producer: [0, 2], outcome: "errored", diagnostic: "exit 2" });
});

test("arrivals the core would reject are shaped into accepted ones", () => {
  const oversized = toArrival([0, 1], { outcome: "completed", memory: "x".repeat(32 * 1024 + 1) });
  assert.equal(oversized.outcome, "errored");
  assert.match(oversized.diagnostic, /exceeds 32768 bytes/);
  assert.equal(oversized.memory, undefined);

  const empty = toArrival([0, 1], { outcome: "completed", memory: "  " });
  assert.deepEqual(empty, { producer: [0, 1], outcome: "errored", diagnostic: "spawn child ended without memory" });

  const long = toArrival([0, 1], { outcome: "errored", diagnostic: "é".repeat(4096) });
  assert.ok(new TextEncoder().encode(long.diagnostic).byteLength <= 4096);
});

test("cancellation ends as aborted unless the child had already returned", async () => {
  const controller = new AbortController();
  controller.abort();
  const { executor } = scripted({ outcome: "errored", diagnostic: "killed" });
  const aborted = await runSpawnChild({ producer: [0, 1], task, executor, signal: controller.signal });
  assert.deepEqual(aborted, { producer: [0, 1], outcome: "aborted", diagnostic: "killed" });

  assert.equal(toArrival([0, 1], { outcome: "completed", memory: "late" }, true).outcome, "completed");
});

test("an executor exception becomes an errored arrival", async () => {
  const { executor } = scripted(new Error("spawn ENOENT"));
  const arrival = await runSpawnChild({ producer: [0, 1], task, executor, signal: new AbortController().signal });
  assert.deepEqual(arrival, { producer: [0, 1], outcome: "errored", diagnostic: "spawn ENOENT" });
});

test("recovery decides per child: retry and continue run again, abandon arrives as failed", async () => {
  const decisions = [{ action: "retry", guidance: " try smaller " }, { action: "continue" }];
  const seen = [];
  const recovery = {
    async choose(failure) {
      seen.push(failure);
      return decisions.shift();
    },
  };
  const { executor, calls } = scripted(
    { outcome: "errored", diagnostic: "first", recovery: { continueable: false, reason: "no session" } },
    { outcome: "errored", diagnostic: "second" },
    { outcome: "completed", memory: "third time" },
  );
  const arrival = await runSpawnChild({ producer: [0, 1], task, executor, recovery, signal: new AbortController().signal });
  assert.equal(arrival.outcome, "completed");
  assert.deepEqual(calls, [
    { attempt: 0, mode: "initial", guidance: undefined },
    { attempt: 1, mode: "retry", guidance: "try smaller" },
    { attempt: 1, mode: "continue", guidance: undefined },
  ]);
  assert.equal(seen[0].continueable, false);
  assert.equal(seen[0].continueReason, "no session");
  assert.equal(seen[0].retryable, true);

  const abandon = scripted({ outcome: "errored", diagnostic: "broken" });
  const abandoned = await runSpawnChild({
    producer: [0, 1],
    task,
    executor: abandon.executor,
    recovery: { async choose() { return { action: "abandon" }; } },
    signal: new AbortController().signal,
  });
  assert.deepEqual(abandoned, { producer: [0, 1], outcome: "errored", diagnostic: "broken" });
});
