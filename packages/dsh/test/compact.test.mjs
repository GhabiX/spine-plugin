// Spine-aware compaction on the production DSH AgentLoop: provider overflow
// recovery, /compact, and their interaction with resume, Fork and Spawn.
import assert from "node:assert/strict";
import test from "node:test";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { buildForkSeed, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";

import { MAX_SUMMARY_REQUESTS } from "../dist/compact.js";
import { checkpoints, ends, mountCompact, overflow, summary, text } from "./compact-helpers.mjs";

const mainRequests = (dsh) => dsh.adapter.requests.filter((request) => request.purpose !== "compaction");
const summaryRequests = (dsh) => dsh.adapter.requests.filter((request) => request.purpose === "compaction");

async function until(condition) {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries === 500) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("context overflows across turns compact at a Spine barrier and every turn continues, before and after restart", async () => {
  const dsh = await mountCompact([
    "first answer",
    overflow, summary("SUMMARY-ONE: user said hello and second"), "recovered answer",
    "third answer",
    overflow, summary("SUMMARY-TWO: everything so far"), "fourth answer",
  ]);
  let root;
  try {
    const agent = await dsh.run("hello");
    await dsh.send(agent, "second");
    await dsh.send(agent, "third");
    await dsh.send(agent, "fourth");
    assert.deepEqual(ends(agent), ["completed", "completed", "completed", "completed"]);
    assert.equal(checkpoints(agent).length, 2);
    assert.equal(agent.session.snapshotEvents().filter((event) => event.type === "compaction/start").length, 0,
      "no host compaction transaction ran");
    const main = mainRequests(dsh);
    // The retry after the first overflow sees the checkpoint, not the history it replaced.
    assert.match(text(main[2]), /SUMMARY-ONE/);
    assert.doesNotMatch(text(main[2]), /first answer/);
    assert.match(text(main[3]), /SUMMARY-ONE[^]*recovered answer[^]*third/);
    assert.match(text(main[5]), /SUMMARY-TWO/);
    assert.doesNotMatch(text(main[5]), /SUMMARY-ONE|third answer/);
    assert.equal(summaryRequests(dsh).length, 2);
    root = await dsh.crashed();
  } finally {
    await dsh.dispose();
  }

  const resumed = await mountCompact(["fifth answer"], { root });
  try {
    const agent = await resumed.resume("session-1");
    await resumed.send(agent, "fifth");
    assert.equal(ends(agent).at(-1), "completed");
    const [request] = resumed.adapter.requests;
    assert.match(text(request), /SUMMARY-TWO[^]*fourth answer[^]*fifth/);
    assert.doesNotMatch(text(request), /SUMMARY-ONE|first answer/);
    assert.deepEqual(await resumed.restored(agent), agent.session.deriveMessages());
  } finally {
    await resumed.dispose();
  }
});

test("one overflow recovery per reply: an overflow right after compaction fails the turn without looping, and the next turn works", async () => {
  const dsh = await mountCompact(["first", overflow, summary("SUMMARY"), overflow, "next ok"]);
  try {
    const agent = await dsh.run("hello");
    await dsh.send(agent, "second");
    assert.deepEqual(ends(agent), ["completed", "error"]);
    assert.equal(dsh.adapter.requests.length, 4);
    assert.equal(checkpoints(agent).length, 1);
    await dsh.send(agent, "again");
    assert.deepEqual(ends(agent), ["completed", "error", "completed"]);
    assert.match(text(dsh.adapter.requests[4]), /SUMMARY[^]*again/);
  } finally {
    await dsh.dispose();
  }
});

test("summary requests are capped: a history needing more summary requests than allowed fails without a checkpoint", async () => {
  // Far more than MAX_SUMMARY_REQUESTS chunks of the default 16k-token window.
  const huge = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const dsh = await mountCompact(["first", overflow, ...Array.from({ length: MAX_SUMMARY_REQUESTS }, () => summary("part")), "after"]);
  try {
    const agent = await dsh.run(huge);
    await dsh.send(agent, "second");
    assert.deepEqual(ends(agent), ["completed", "error"]);
    assert.equal(summaryRequests(dsh).length, MAX_SUMMARY_REQUESTS);
    assert.ok(summaryRequests(dsh).every((request) => text(request).length < 40_000), "each summary input is bounded");
    assert.equal(checkpoints(agent).length, 0);
    await dsh.send(agent, "third");
    assert.equal(ends(agent).at(-1), "completed");
  } finally {
    await dsh.dispose();
  }
});

test("an overflow the summarizer cannot split below its minimum input fails without a checkpoint", async () => {
  const dsh = await mountCompact(["first", overflow, overflow, "after"]);
  try {
    const agent = await dsh.run("hello");
    await dsh.send(agent, "second");
    assert.deepEqual(ends(agent), ["completed", "error"]);
    assert.equal(summaryRequests(dsh).length, 1);
    assert.equal(checkpoints(agent).length, 0);
    await dsh.send(agent, "third");
    assert.equal(ends(agent).at(-1), "completed");
  } finally {
    await dsh.dispose();
  }
});

test("/compact (ctx.compaction.compactNow) checkpoints an idle session; Fork and resume continue from the checkpoint", async () => {
  const dsh = await mountCompact([
    [["spine_open", { goal: "old task" }]], "original-answer-only",
    summary("CHECKPOINT BODY"),
    "after compact",
    "fork reply",
  ]);
  let root;
  try {
    const agent = await dsh.run("remember this");
    const result = await dsh.ctx.compaction.compactNow(agent, new AbortController().signal);
    assert.ok(result !== null);
    const [marker] = checkpoints(agent);
    assert.equal(result.summarySeq, marker.seq);
    assert.equal(result.summary[0].text, "CHECKPOINT BODY");
    assert.equal(agent.session.eventAt(result.startSeq).type, "compaction/prune");
    assert.equal(await dsh.ctx.compaction.compactNow(agent, new AbortController().signal), null,
      "nothing new to compact");
    await dsh.send(agent, "go on");
    assert.match(text(mainRequests(dsh)[2]), /CHECKPOINT BODY[^]*go on/);
    assert.doesNotMatch(text(mainRequests(dsh)[2]), /original-answer-only/);

    const { agent: branch } = await dsh.ctx.agents.create({
      sessionId: SessionId("fork-1"),
      seed: buildForkSeed(agent.session.snapshotEvents(), agent.session.seq - 1),
      inheritedEventCount: SessionLogOffset(agent.session.seq),
      meta: { cwd: dsh.root, isSeeded: true },
      agentOptions: { provider: "scripted", model: "scripted" },
    });
    await dsh.send(branch, "fork input");
    assert.deepEqual(ends(branch).at(-1), "completed");
    const forkRequest = mainRequests(dsh).at(-1);
    assert.equal(forkRequest.sessionId, "fork-1");
    assert.match(text(forkRequest), /CHECKPOINT BODY[^]*after compact[^]*fork input/);
    assert.doesNotMatch(text(forkRequest), /original-answer-only/);
    root = await dsh.crashed();
  } finally {
    await dsh.dispose();
  }

  const resumed = await mountCompact(["resumed main", "resumed fork"], { root });
  try {
    for (const [id, input] of [["session-1", "main again"], ["fork-1", "fork again"]]) {
      const agent = await resumed.resume(id);
      await resumed.send(agent, input);
      assert.equal(ends(agent).at(-1), "completed");
    }
    const [main, fork] = resumed.adapter.requests;
    assert.match(text(main), /CHECKPOINT BODY[^]*after compact[^]*main again/);
    assert.match(text(fork), /CHECKPOINT BODY[^]*fork reply[^]*fork again/);
    for (const request of [main, fork]) assert.doesNotMatch(text(request), /original-answer-only/);
  } finally {
    await resumed.dispose();
  }
});

test("compaction waits for Spawn arrivals: /compact is busy and overflow does not compact while a child is out", async () => {
  const X = "session-1:spawn:1.1.1";
  const Y = "session-1:spawn:1.1.2";
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const dsh = await mountCompact({
    "session-1": [
      [["spine_open", { goal: "A" }]],
      [["spine_spawn", { tasks: [{ summary: "X", prompt: "find x" }, { summary: "Y", prompt: "find y" }] }]],
      "waiting",
      overflow,
      "got x",
      "got y",
      summary("SUMMARY WITH X AND Y"),
      "after compact",
    ],
    [X]: [async () => { await released; return "x is 42"; }],
    [Y]: [async () => { await released; return "y is 7"; }],
  });
  try {
    const agent = await dsh.run("start");
    await assert.rejects(dsh.ctx.compaction.compactNow(agent, new AbortController().signal),
      (error) => error instanceof ManualCompactionError && error.code === "busy");
    await dsh.send(agent, "while waiting");
    assert.deepEqual(ends(agent), ["completed", "error"], "an overflow with a child out is not compacted");
    assert.equal(checkpoints(agent).length, 0);
    release();
    await until(() => ends(agent).length >= 3 && agent.status === "idle" &&
      mainRequests(dsh).filter((request) => request.sessionId === "session-1").some((request) => /y is 7/.test(text(request)) && /x is 42/.test(text(request))));
    await agent.whenIdle();
    assert.ok(ends(agent).slice(2).every((end) => end === "completed"));
    const result = await dsh.ctx.compaction.compactNow(agent, new AbortController().signal);
    assert.ok(result !== null);
    await dsh.send(agent, "continue");
    assert.equal(ends(agent).at(-1), "completed");
    const last = mainRequests(dsh).at(-1);
    assert.match(text(last), /SUMMARY WITH X AND Y[^]*continue/);
    assert.doesNotMatch(text(last), /x is 42|y is 7/);
  } finally {
    await dsh.dispose();
  }
});
