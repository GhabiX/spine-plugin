// Spawn on the production DSH AgentLoop. Children are forked subagents in the
// same world; each session's replies are scripted by its id.
import assert from "node:assert/strict";
import test from "node:test";

import { mountDsh } from "./harness.mjs";
import { arrival, call, memory, node, shown, staged } from "./shown.mjs";

const X = "session-1:spawn:1.1.1";
const Y = "session-1:spawn:1.1.2";
const spawnXY = [["spine_spawn", { tasks: [{ summary: "X", prompt: "find x" }, { summary: "Y", prompt: "find y" }] }]];
const returns = (memory) => [["spine_child_return", { memory }]];

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, after: (reply) => async () => { await opened; return reply; } };
}

async function until(condition) {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries === 500) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ends = (dsh, id) => dsh.events(id).filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind);
const requestsOf = (dsh, id) => dsh.adapter.requests.filter((request) => request.sessionId === id).map(shown);

/** Replies "waiting" until a request shows `count` arrivals, then `replies` in order. */
function afterArrivals(count, ...replies) {
  return Array.from({ length: count + replies.length + 1 }, () => (request) =>
    shown(request).filter((line) => line.startsWith("user: <spine_arrival")).length < count ? "waiting" : replies.shift() ?? "waiting");
}

test("children start from the log before the Spawn; each arrival wakes the parent once", async () => {
  const [x, y] = [gate(), gate()];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "got x", [["spine_close", { memory: "m" }]], "done"],
    [X]: [x.after(returns("x is 42"))],
    [Y]: [y.after(returns("y is 7"))],
  });
  try {
    const agent = await dsh.run("start");
    x.open();
    await until(() => ends(dsh, "session-1").length === 2);
    await agent.whenIdle();
    y.open();
    await until(() => ends(dsh, "session-1").length === 3);
    await agent.whenIdle();

    const parent = requestsOf(dsh, "session-1");
    const births = [
      call("spine_spawn", spawnXY[0][1]), staged("spine_spawn"),
      'spine: <spine_spawn node_id="1.1.1" summary="X">\nfind x\n</spine_spawn>',
      'spine: <spine_spawn node_id="1.1.2" summary="Y">\nfind y\n</spine_spawn>',
    ];
    assert.deepEqual(parent[3], [...parent[1], ...births, "assistant: waiting", arrival("1.1.1", "completed", "x is 42")]);
    assert.deepEqual(parent[4], [...parent[3], "assistant: got x", arrival("1.1.2", "completed", "y is 7")]);
    // Close keeps the births, replies and arrivals, as it keeps child memories.
    assert.deepEqual(parent[5], [
      "user: [U1]\nstart", "context: …", ...births.slice(2), "assistant: waiting", arrival("1.1.1", "completed", "x is 42"),
      "assistant: got x", arrival("1.1.2", "completed", "y is 7"),
      memory("1.1", "m"), call("spine_close", { memory: "m" }), staged("spine_close"),
    ]);
    assert.deepEqual(ends(dsh, "session-1"), ["completed", "completed", "completed"]);

    for (const [id, summary, peer] of [[X, "X", "Y"], [Y, "Y", "X"]]) {
      const [first] = requestsOf(dsh, id);
      assert.deepEqual(first.slice(0, -2), parent[1], "the child sees what the parent's Spawn sampling saw");
      assert.equal(first.at(-1), "context: …");
      assert.match(first.at(-2), new RegExp(`^user: \\[U2\\]\\nYou are a spawned execution branch[^]*You are: ${summary}\\n[^]*- ${peer}\\n`));
      assert.deepEqual(ends(dsh, id), ["completed"]);
      const restored = shown({ messages: await dsh.restored(id) });
      assert.deepEqual(restored.slice(0, first.length), first, "official JSONL restore of the child");
    }
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore of the parent");
  } finally {
    await dsh.dispose();
  }
});

test("Close and a child's return wait for their children; a child that ends without returning arrives errored", async () => {
  const [x1, y] = [gate(), gate()];
  const dsh = await mountDsh({
    "session-1": [
      [["spine_open", { goal: "A" }]], spawnXY, [["spine_close", { memory: "early" }]],
      ...afterArrivals(2, [["spine_close", { memory: "m" }]], "done"),
    ],
    [X]: [
      [["spine_spawn", { tasks: [{ summary: "X1", prompt: "a" }, { summary: "X2", prompt: "b" }] }]],
      (request) => { x1.open(); return returns("too early"); },
      ...afterArrivals(2, returns("x after X1 and X2")),
    ],
    [`${X}:spawn:1.1.1`]: [x1.after(returns("x1"))],
    [`${X}:spawn:1.1.2`]: [x1.after(returns("x2"))],
    [Y]: [y.after("I am done")],
  });
  try {
    const agent = await dsh.run("start");
    y.open();
    await until(() => ends(dsh, "session-1").length === 3 && agent.status === "idle");
    await agent.whenIdle();

    const results = (id) => dsh.events(id).filter((event) => event.type === "tool/result").map((event) => event.data.message);
    const early = results("session-1")[2];
    assert.equal(early.isError, true);
    assert.match(early.content[0].text, /Spawned children 1\.1\.1 \(X\), 1\.1\.2 \(Y\) have not arrived/);
    const tooEarly = results(X)[1];
    assert.equal(tooEarly.isError, true);
    assert.match(tooEarly.content[0].text, /Spawned children 1\.1\.1 \(X1\), 1\.1\.2 \(X2\) have not arrived/);

    const last = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), call("spine_close", { memory: "m" }), staged("spine_close")]);
    assert.deepEqual(last.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
      arrival("1.1.1", "completed", "x after X1 and X2"),
      arrival("1.1.2", "errored", "the child went idle without calling spine_child_return"),
    ]);
    assert.deepEqual(ends(dsh, `${X}:spawn:1.1.1`), ["completed"]);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("stopping the parent stops its children: they arrive aborted and do not wake it", async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, { hang: true }, "ok"],
    [X]: [{ hang: true }],
    [Y]: [{ hang: true }],
  });
  try {
    const run = dsh.run("start");
    await until(() => requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1 && requestsOf(dsh, "session-1").length === 3);
    dsh.agent.cancel({ kind: "user" });
    await run;
    const parent = dsh.agent;
    await until(() => parent.inbox.nextStep.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requestsOf(dsh, "session-1").length, 3, "the aborted arrivals did not wake the parent");
    assert.equal(parent.inbox.nextStep.length, 2);
    assert.deepEqual(ends(dsh, X), ["aborted"]);
    assert.deepEqual(ends(dsh, Y), ["aborted"]);

    await dsh.send(parent, "go on");
    const last = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(last.slice(-3).toSorted(), [
      arrival("1.1.1", "aborted", "spawn child was cancelled"),
      arrival("1.1.2", "aborted", "spawn child was cancelled"),
      "user: [U2]\ngo on",
    ].toSorted());
    assert.deepEqual(ends(dsh, "session-1"), ["aborted", "completed"]);
    assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("a restarted parent receives a returned child as completed and a running one as aborted, without waking", async () => {
  const first = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, { hang: true }],
    [X]: [returns("x is 42")],
    [Y]: [{ hang: true }],
  });
  let root;
  try {
    const run = first.run("start");
    await until(() => ends(first, X).length === 1 && requestsOf(first, Y).length === 1 && first.agent.inbox.nextStep.length === 1);
    root = first.root;
    void run.catch(() => {});
  } finally {
    await first.dispose();
  }

  const dsh = await mountDsh(["noted"], { root });
  try {
    const agent = await dsh.resume("session-1");
    await until(() => agent.inbox.nextStep.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dsh.adapter.requests.length, 0, "recovered arrivals do not wake the parent");
    assert.equal(agent.inbox.nextStep.length, 2, "each birth arrives once");
    await dsh.send(agent, "continue");
    const [request] = dsh.adapter.requests.map(shown);
    assert.equal(request.filter((line) => line.startsWith("user: <spine_arrival")).length, 2);
    assert.deepEqual(request.slice(-3).toSorted(), [
      arrival("1.1.1", "completed", "x is 42"),
      arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      "user: [U2]\ncontinue",
    ].toSorted());
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("a child forked while earlier births are pending leaves them to its parent", async () => {
  const later = gate();
  const spawnZW = [["spine_spawn", { tasks: [{ summary: "Z", prompt: "find z" }, { summary: "W", prompt: "find w" }] }]];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, spawnZW, ...afterArrivals(4, [["spine_close", { memory: "m" }]], "done")],
    [X]: [later.after(returns("x"))],
    [Y]: [later.after(returns("y"))],
    "session-1:spawn:1.1.3": [returns("z")],
    "session-1:spawn:1.1.4": [returns("w")],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => ends(dsh, "session-1:spawn:1.1.3").length === 1 && ends(dsh, "session-1:spawn:1.1.4").length === 1);
    for (const id of ["session-1:spawn:1.1.3", "session-1:spawn:1.1.4"]) {
      const requests = requestsOf(dsh, id);
      assert.equal(requests.length, 1, "the child returns at once: X and Y are its parent's to join");
      assert.equal(requests[0].filter((line) => line.startsWith("user: <spine_arrival")).length, 0);
    }
    later.open();
    await until(() => requestsOf(dsh, "session-1").at(-1).at(-1) === staged("spine_close") && agent.status === "idle");
    const last = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(last.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
      arrival("1.1.1", "completed", "x"),
      arrival("1.1.2", "completed", "y"),
      arrival("1.1.3", "completed", "z"),
      arrival("1.1.4", "completed", "w"),
    ]);
  } finally {
    await dsh.dispose();
  }
});

test("a headless run ends only after the parent has taken its children's arrivals", async () => {
  const later = (reply) => () => new Promise((resolve) => setTimeout(() => resolve(reply), 50));
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", ...afterArrivals(2, [["spine_close", { memory: "m" }]], "x is 42, y is 7")],
    [X]: [later(returns("x is 42"))],
    [Y]: [later(returns("y is 7"))],
  });
  try {
    const agent = await dsh.runHeadless("start");
    const last = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), call("spine_close", { memory: "m" }), staged("spine_close")]);
    assert.deepEqual(last.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
      arrival("1.1.1", "completed", "x is 42"),
      arrival("1.1.2", "completed", "y is 7"),
    ]);
    const answer = agent.session.deriveMessages().at(-1);
    assert.equal(answer.role, "assistant");
    assert.equal(answer.content[0].text, "x is 42, y is 7");
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("a child beyond the subagent limit arrives errored and wakes the parent; the others run", async () => {
  const tasks = Array.from({ length: 9 }, (_, k) => ({ summary: `T${k + 1}`, prompt: "t" }));
  const children = Object.fromEntries(tasks.map((_, k) => [`session-1:spawn:1.1.${k + 1}`, [{ hang: true }]]));
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], [["spine_spawn", { tasks }]], ...afterArrivals(1, "noted")],
    ...children,
  });
  try {
    await dsh.run("start");
    const arrivals = () => (requestsOf(dsh, "session-1").at(-1) ?? []).filter((line) => line.startsWith("user: <spine_arrival"));
    await until(() => arrivals().length === 1);
    assert.match(arrivals()[0], /outcome="errored"[\s\S]*subagent limit reached \(active child limit: 8\)/);
    await until(() => Object.keys(children).filter((id) => requestsOf(dsh, id).length === 1).length === 8);
  } finally {
    await dsh.dispose();
  }
});
