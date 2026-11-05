// Spawn on the production DSH AgentLoop. Children are forked subagents in the
// same world; each session's replies are scripted by its id.
import assert from "node:assert/strict";
import test from "node:test";

import { mountDsh } from "./harness.mjs";
import { arrival, call, memory, shown, result, closed } from "./shown.mjs";

const X = "session-1:spawn:1.1.1";
const Y = "session-1:spawn:1.1.2";
const spawnXY = [["spine_spawn", { tasks: [{ summary: "X", prompt: "find x" }, { summary: "Y", prompt: "find y" }] }]];

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
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "got x", [["spine_close", { memory: "m" }]], "done", "ok"],
    [X]: [x.after("x is 42")],
    [Y]: [y.after("y is 7")],
  });
  try {
    const agent = await dsh.run("start");
    x.open();
    await until(() => ends(dsh, "session-1").length === 2);
    await agent.whenIdle();
    y.open();
    await until(() => ends(dsh, "session-1").length === 3);
    await agent.whenIdle();
    await dsh.send(agent, "thanks");

    const parent = requestsOf(dsh, "session-1");
    const births = [
      call("spine_spawn", spawnXY[0][1]), result("spine_spawn", 2),
      'spine: <spine_spawn node_id="1.1.1" summary="X">\n</spine_spawn>',
      'spine: <spine_spawn node_id="1.1.2" summary="Y">\n</spine_spawn>',
    ];
    assert.deepEqual(parent[3], [...parent[1], ...births, "assistant: waiting", arrival("1.1.1", "completed", "x is 42")]);
    assert.deepEqual(parent[4], [...parent[3], "assistant: got x", arrival("1.1.2", "completed", "y is 7")]);
    assert.deepEqual(parent[5], [...parent[4], call("spine_close", { memory: "m" }), result("spine_close")]);
    // Once folded, the node keeps the births and arrivals, as it keeps child
    // memories; the replies given while a birth was unarrived only reported waiting.
    assert.deepEqual(parent[6], [
      "user: [U1]\nstart", "context: …", closed("1.1", "A"), ...births.slice(2), arrival("1.1.1", "completed", "x is 42"),
      arrival("1.1.2", "completed", "y is 7"), memory("1.1", "m"), "assistant: done", "user: [U2]\nthanks",
    ]);
    assert.deepEqual(ends(dsh, "session-1"), ["completed", "completed", "completed", "completed"]);

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

test("a child cannot close the node it was spawned in: the tool errors and its final reply is its result", async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "waiting", "got both", "done"],
    [X]: [[["spine_close", { memory: "x is 42" }]], "x is 42"],
    [Y]: ["y is 7"],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => ends(dsh, X).length === 1 && ends(dsh, Y).length === 1);
    await agent.whenIdle();
    const refused = dsh.events(X).filter((event) => event.type === "tool/result").map((event) => event.data.message)
      .find((message) => message.isError === true);
    assert.match(refused.content[0].text, /1\.1 belongs to the session that spawned you/);
    const last = requestsOf(dsh, "session-1").at(-1);
    assert.ok(last.includes(arrival("1.1.1", "completed", "x is 42")), "X's final reply is its result");
  } finally {
    await dsh.dispose();
  }
});

test("Close and a child's end wait for their children: a reply before they arrive does not end it", async () => {
  const [x1, y] = [gate(), gate()];
  const dsh = await mountDsh({
    "session-1": [
      [["spine_open", { goal: "A" }]], spawnXY, [["spine_close", { memory: "early" }]],
      ...afterArrivals(2, [["spine_close", { memory: "m" }]], "done", "ok"),
    ],
    [X]: [
      [["spine_spawn", { tasks: [{ summary: "X1", prompt: "a" }, { summary: "X2", prompt: "b" }] }]],
      () => { x1.open(); return "too early"; },
      ...afterArrivals(2, "x after X1 and X2"),
    ],
    [`${X}:spawn:1.1.1`]: [x1.after("x1")],
    [`${X}:spawn:1.1.2`]: [x1.after("x2")],
    [Y]: [y.after("I am done")],
  });
  try {
    const agent = await dsh.run("start");
    y.open();
    await until(() => ends(dsh, "session-1").length === 3 && agent.status === "idle");
    await agent.whenIdle();
    await dsh.send(agent, "thanks");

    const results = (id) => dsh.events(id).filter((event) => event.type === "tool/result").map((event) => event.data.message);
    const early = results("session-1")[2];
    assert.equal(early.isError, true);
    assert.match(early.content[0].text, /Spawned children 1\.1\.1 \(X\), 1\.1\.2 \(Y\) have not arrived/);

    const [unfolded, last] = requestsOf(dsh, "session-1").slice(-2);
    assert.deepEqual(unfolded.slice(-2), [call("spine_close", { memory: "m" }), result("spine_close")], "the node shows as it was");
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), "assistant: done", "user: [U2]\nthanks"], "the memory ends the folded node");
    assert.ok(last.findLastIndex((line) => line.startsWith("user: <spine_arrival")) < last.length - 3, "what the node keeps comes first");
    for (const request of [unfolded, last]) {
      assert.deepEqual(request.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
        arrival("1.1.1", "completed", "x after X1 and X2"),
        arrival("1.1.2", "completed", "I am done"),
      ]);
    }
    assert.deepEqual(ends(dsh, `${X}:spawn:1.1.1`), ["completed"]);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("a child whose model request fails arrives errored with the failure", async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, ...afterArrivals(2, "noted")],
    [X]: [{ fail: "403 insufficient balance" }],
    [Y]: ["y is 7"],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => requestsOf(dsh, "session-1").at(-1).filter((line) => line.startsWith("user: <spine_arrival")).length === 2 && agent.status === "idle");
    assert.deepEqual(requestsOf(dsh, "session-1").at(-1).filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
      arrival("1.1.1", "errored", "403 insufficient balance"),
      arrival("1.1.2", "completed", "y is 7"),
    ]);
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

test("a restarted parent reads each child's end from its log: none reruns or wakes it", async () => {
  // X replied, Y runs, Z's request failed, W waits for its own children.
  const tasks = ["X", "Y", "Z", "W"].map((summary) => ({ summary, prompt: summary.toLowerCase() }));
  const [Z, W] = ["session-1:spawn:1.1.3", "session-1:spawn:1.1.4"];
  const first = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], [["spine_spawn", { tasks }]], { hang: true }],
    [X]: ["x is 42"],
    [Y]: [{ hang: true }],
    [Z]: [{ fail: "403 insufficient balance" }],
    [W]: [[["spine_spawn", { tasks: [{ summary: "G1", prompt: "g" }, { summary: "G2", prompt: "g" }] }]], "waiting for G1 and G2"],
    [`${W}:spawn:1.1.1`]: [{ hang: true }],
    [`${W}:spawn:1.1.2`]: [{ hang: true }],
  });
  let root;
  try {
    const run = first.run("start");
    await until(() => ends(first, X).length === 1 && ends(first, Z).length === 1 && ends(first, W).length === 1 &&
      requestsOf(first, Y).length === 1 && requestsOf(first, `${W}:spawn:1.1.2`).length === 1 && first.agent.inbox.nextStep.length === 2);
    // X's and Z's arrivals wait in the parent's durable inbox when it is killed.
    root = await first.crashed();
    void run.catch(() => {});
  } finally {
    await first.dispose();
  }

  const dsh = await mountDsh(["noted"], { root });
  try {
    const agent = await dsh.resume("session-1");
    await until(() => agent.inbox.nextStep.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dsh.adapter.requests.length, 0, "recovered arrivals do not wake the parent");
    assert.equal(agent.inbox.nextStep.length, 4, "each birth arrives once");
    await dsh.send(agent, "continue");
    const [request] = dsh.adapter.requests.map(shown);
    assert.deepEqual(request.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
      arrival("1.1.1", "completed", "x is 42"),
      arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      arrival("1.1.3", "errored", "403 insufficient balance"),
      arrival("1.1.4", "aborted", "the parent session restarted before this child returned"),
    ]);
    assert.equal(request.at(-1), "user: [U2]\ncontinue");
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("a reply after a cut-off step in the same turn still ends the child", async () => {
  const [G1, G2] = [`${X}:spawn:1.1.1`, `${X}:spawn:1.1.2`];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, ...afterArrivals(2, "noted")],
    // G1's and G2's arrivals are steered into X's turn while a cut-off step runs; X replies in the same turn.
    [X]: [
      [["spine_spawn", { tasks: [{ summary: "G1", prompt: "g" }, { summary: "G2", prompt: "g" }] }]],
      async () => { await until(() => ends(dsh, G1).length === 1 && ends(dsh, G2).length === 1); return { text: "partial", finish: "max-tokens" }; },
      "x final",
    ],
    [Y]: ["y is 7"],
    [G1]: ["g1"],
    [G2]: ["g2"],
  });
  try {
    const agent = await dsh.run("start");
    const arrivals = () => requestsOf(dsh, "session-1").at(-1).filter((line) => line.startsWith("user: <spine_arrival"));
    await until(() => arrivals().length === 2 && agent.status === "idle");
    assert.deepEqual(ends(dsh, X), ["max-tokens"], "the turn keeps its cut-off end reason");
    assert.deepEqual(arrivals().toSorted(), [arrival("1.1.1", "completed", "x final"), arrival("1.1.2", "completed", "y is 7")]);
  } finally {
    await dsh.dispose();
  }
});

test("a child forked while earlier births are pending leaves them to its parent", async () => {
  const later = gate();
  const spawnZW = [["spine_spawn", { tasks: [{ summary: "Z", prompt: "find z" }, { summary: "W", prompt: "find w" }] }]];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, spawnZW, ...afterArrivals(4, [["spine_close", { memory: "m" }]], "done", "ok")],
    [X]: [later.after("x")],
    [Y]: [later.after("y")],
    "session-1:spawn:1.1.3": ["z"],
    "session-1:spawn:1.1.4": ["w"],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => ends(dsh, "session-1:spawn:1.1.3").length === 1 && ends(dsh, "session-1:spawn:1.1.4").length === 1);
    for (const id of ["session-1:spawn:1.1.3", "session-1:spawn:1.1.4"]) {
      const requests = requestsOf(dsh, id);
      assert.equal(requests.length, 1, "the child ends at once: X and Y are its parent's to join");
      assert.equal(requests[0].filter((line) => line.startsWith("user: <spine_arrival")).length, 0);
    }
    later.open();
    await until(() => requestsOf(dsh, "session-1").at(-1).includes(call("spine_close", { memory: "m" })) && agent.status === "idle");
    await dsh.send(agent, "thanks");
    const [unfolded, last] = requestsOf(dsh, "session-1").slice(-2);
    assert.ok(last.includes(memory("1.1", "m")), "the next sampling folded the node");
    for (const request of [unfolded, last]) {
      assert.deepEqual(request.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
        arrival("1.1.1", "completed", "x"),
        arrival("1.1.2", "completed", "y"),
        arrival("1.1.3", "completed", "z"),
        arrival("1.1.4", "completed", "w"),
      ]);
    }
  } finally {
    await dsh.dispose();
  }
});

test("a headless run ends only after the parent has taken its children's arrivals", async () => {
  const later = (reply) => () => new Promise((resolve) => setTimeout(() => resolve(reply), 50));
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", ...afterArrivals(2, [["spine_close", { memory: "m" }]], "x is 42, y is 7", "ok")],
    [X]: [later("x is 42")],
    [Y]: [later("y is 7")],
  });
  try {
    const agent = await dsh.runHeadless("start");
    const unfolded = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(unfolded.slice(-2), [call("spine_close", { memory: "m" }), result("spine_close")], "the node shows as it was");
    const answer = agent.session.deriveMessages().at(-1);
    assert.equal(answer.role, "assistant");
    assert.equal(answer.content[0].text, "x is 42, y is 7");
    // The answer folded the node; the next turn shows it folded.
    await dsh.send(agent, "thanks");
    const last = requestsOf(dsh, "session-1").at(-1);
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), "assistant: x is 42, y is 7", "user: [U2]\nthanks"], "the memory ends the folded node");
    assert.ok(last.findLastIndex((line) => line.startsWith("user: <spine_arrival")) < last.length - 3, "what the node keeps comes first");
    for (const request of [unfolded, last]) {
      assert.deepEqual(request.filter((line) => line.startsWith("user: <spine_arrival")).toSorted(), [
        arrival("1.1.1", "completed", "x is 42"),
        arrival("1.1.2", "completed", "y is 7"),
      ]);
    }
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

test("a node a call opens is described in the call's result, numbered after the births as the core numbers it", async () => {
  const dsh = await mountDsh({
    "session-1": [
      [["spine_open", { goal: "A" }]], spawnXY, [["spine_open", { goal: "B" }]], [["spine_open", { goal: "C" }]],
      [["spine_next", { memory: "memC", goal: "D" }]], [["spine_close", { memory: "memD" }]], [["spine_close", { memory: "memB" }]],
      ...afterArrivals(2, [["spine_close", { memory: "memA" }]], "done", "ok"),
    ],
    [X]: ["x is 42"],
    [Y]: ["y is 7"],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => requestsOf(dsh, "session-1").some((request) => request.at(-1) === result("spine_close", "1.1")) && agent.status === "idle");
    await dsh.send(agent, "thanks");
    const parent = requestsOf(dsh, "session-1");
    // 1.1 holds the births 1.1.1 and 1.1.2, so B is 1.1.3; C, opened in B, is 1.1.3.1; D, after C, 1.1.3.2.
    const opened = [[1, "1.1", "A"], [3, "1.1.3", "B"], [4, "1.1.3.1", "C"], [5, "1.1.3.2", "D"]];
    for (const [index, id, summary] of opened) {
      // Arrivals may land anywhere after the Spawn, so find the result rather than take the last line.
      const opening = summary === "D" ? result("spine_next", "1.1.3.1", id, summary) : result("spine_open", id, summary);
      assert.ok(parent[index].includes(opening) && !parent[index - 1].includes(opening), `${summary} opens as ${id}`);
      // Folded later, the core renders the same node under the same id.
      assert.ok(parent.slice(index + 1).some((request) => request.includes(closed(id, summary))), `${id} folds as ${summary}`);
    }
    // No request carries an opened node's descriptor as an item of its own.
    for (const request of parent) {
      assert.deepEqual(request.filter((line) => line.startsWith("spine: <spine_node") && line.includes('status="opened"')), []);
    }
  } finally {
    await dsh.dispose();
  }
});
