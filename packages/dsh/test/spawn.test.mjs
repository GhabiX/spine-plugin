// Spawn on the production DSH AgentLoop. Children are forked subagents in the
// same world; each session's replies are scripted by its id.
import assert from "node:assert/strict";
import test from "node:test";

import { mountDsh, reloadSpine } from "./harness.mjs";
import { recoverChildren } from "../dist/spawn.js";
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
      arrival("1.1.2", "completed", "y is 7"), memory("1.1", "m"), "assistant: done", "user: thanks",
    ]);
    assert.deepEqual(ends(dsh, "session-1"), ["completed", "completed", "completed", "completed"]);

    for (const [id, summary, peer] of [[X, "X", "Y"], [Y, "Y", "X"]]) {
      const [first] = requestsOf(dsh, id);
      assert.deepEqual(first.slice(0, -2), parent[1], "the child sees what the parent's Spawn sampling saw");
      assert.equal(first.at(-1), "context: …");
      assert.match(first.at(-2), new RegExp(`^user: You are a spawned execution branch[^]*You are: ${summary}\\n[^]*- ${peer}\\n`));
      assert.deepEqual(ends(dsh, id), ["completed"]);
      const restored = shown({ messages: await dsh.restored(id) });
      // Its first request showed the assignment as written; from then on the child numbers it.
      const later = first.with(-2, first.at(-2).replace(/^user: /, "user: [U2]\n"));
      assert.deepEqual(restored.slice(0, first.length), later, "official JSONL restore of the child");
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
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), "assistant: done", "user: thanks"], "the memory ends the folded node");
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

test("an idle Spawn child stays available until its descendants reply", async () => {
  const [first, second] = [gate(), gate()];
  const [G1, G2] = [`${X}:spawn:1.1.1`, `${X}:spawn:1.1.2`];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, ...afterArrivals(2, "got both")],
    [X]: [
      [["spine_spawn", { tasks: [{ summary: "G1", prompt: "g1" }, { summary: "G2", prompt: "g2" }] }]],
      ...afterArrivals(2, "x combined g1 and g2"),
    ],
    [Y]: ["y"],
    [G1]: [first.after("g1 late")],
    [G2]: [second.after("g2 late")],
  });
  try {
    const agent = await dsh.run("start");
    const getChild = () => dsh.ctx.agents.get(X);
    await until(() => ends(dsh, X).length === 1 && requestsOf(dsh, G1).length === 1 && requestsOf(dsh, G2).length === 1);
    const child = getChild();
    assert.ok(child, "X is still present after it first yields");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(getChild(), child, "DSH retains an idle X while both descendants run");
    assert.equal(child.status, "idle");
    assert.equal(requestsOf(dsh, X).length, 2, "waiting does not start extra model requests");

    first.open();
    await until(() => ends(dsh, X).length === 2);
    assert.ok(requestsOf(dsh, X).at(-1).includes(arrival("1.1.1", "completed", "g1 late")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(getChild(), child, "X is retained again after processing just one result");
    second.open();
    const final = arrival("1.1.1", "completed", "x combined g1 and g2");
    await until(() => requestsOf(dsh, "session-1").at(-1)?.includes(final));
    await agent.whenIdle();
    assert.ok(requestsOf(dsh, X).at(-1).includes(arrival("1.1.2", "completed", "g2 late")));
    assert.equal(dsh.events(agent).filter((event) => event.type === "user/message" && event.data.source.kind === "spine-arrival" &&
      event.data.source.arrival.producer.join(".") === "1.1.1").length, 1, "root receives X only once");
  } finally {
    first.open();
    second.open();
    await dsh.dispose();
  }
});

test("a reused provider tool id does not make a child wait for an already completed Spawn", async () => {
  const grandchildren = gate();
  const [G1, G2] = [`${X}:spawn:1.1.1`, `${X}:spawn:1.1.2`];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, ...afterArrivals(2, "got both")],
    [X]: [
      [["spine_spawn", { tasks: [{ summary: "G1", prompt: "g1" }, { summary: "G2", prompt: "g2" }] }]],
      ...afterArrivals(2, [["read_fixture", {}]], "x final"),
    ],
    [Y]: ["y final"],
    [G1]: [grandchildren.after("g1 final")],
    [G2]: [grandchildren.after("g2 final")],
  });
  try {
    const stream = dsh.adapter.stream.bind(dsh.adapter);
    dsh.adapter.stream = async function* (request) {
      for await (const event of stream(request)) {
        if (request.sessionId === X && event.type === "block-end" && event.block.type === "tool-call") {
          yield { ...event, block: { ...event.block, id: "reused-across-turns" } };
        } else {
          yield event;
        }
      }
    };
    dsh.ctx.tools.register({
      name: "read_fixture", description: "Read a fixture.",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: {} }, render: () => [{ type: "text", text: "read ok" }] },
      execute: async () => ({}),
    });

    const agent = await dsh.run("start");
    await until(() => ends(dsh, X).length === 1 && requestsOf(dsh, G1).length === 1 && requestsOf(dsh, G2).length === 1);
    grandchildren.open();
    await until(() => ends(dsh, X).length >= 2 && requestsOf(dsh, X).at(-1).includes("tool: read ok"));
    const calls = dsh.events(X).filter((event) => event.type === "tool/call");
    const results = dsh.events(X).filter((event) => event.type === "tool/result");
    assert.deepEqual(calls.map((event) => event.data.name), ["spine_spawn", "read_fixture"]);
    assert.notEqual(calls[0].data.turn, calls[1].data.turn);
    assert.ok(results.every((event) => event.data.message.toolCallId === "reused-across-turns"));
    assert.deepEqual(results.map((event) => event.sourceEventSeqs), calls.map((event) => [event.seq]));
    const final = arrival("1.1.1", "completed", "x final");
    await until(() => requestsOf(dsh, "session-1").at(-1)?.includes(final));
    await agent.whenIdle();
    // The turn event is visible in memory before the child closes its writer.
    await until(() => dsh.ctx.agents.get(X) === undefined);
    const recovered = await recoverChildren(dsh, agent, [{ producer: [1, 1, 1] }], async () => {});
    assert.equal(recovered[0].outcome, "completed", "durable replay must match the original Spawn only once");
    assert.equal(recovered[0].memory, "x final");

    // Model a log from before DSH persisted exact call links, including a
    // duplicate result to check that fallback matching consumes its call.
    const persistence = dsh.ctx.sessionPersistence;
    const legacy = { ctx: { sessionPersistence: {
      stat: (id) => persistence.stat(id),
      async open(id, mode) {
        const handle = await persistence.open(id, mode);
        return {
          inheritedEventCount: handle.inheritedEventCount,
          close: () => handle.close(),
          async read() {
            const data = await handle.read();
            const [spawnResult] = results;
            const events = data.events.map((event) => {
              if (event.type === "tool/result") return { ...event, sourceEventSeqs: undefined };
              if (event.type === "step/end" && event.seq > spawnResult.seq &&
                event.data.turn === spawnResult.data.turn && event.data.step === spawnResult.data.step) {
                return { ...spawnResult, seq: event.seq, sourceEventSeqs: undefined };
              }
              return event;
            });
            return { ...data, events };
          },
        };
      },
    } } };
    const fallback = await recoverChildren(legacy, agent, [{ producer: [1, 1, 1] }], async () => {});
    assert.deepEqual(fallback, recovered);
  } finally {
    grandchildren.open();
    await dsh.dispose();
  }
});

test("stopping an idle Spawn child cancels its descendants and returns a terminal arrival", async () => {
  const [G1, G2] = [`${X}:spawn:1.1.1`, `${X}:spawn:1.1.2`];
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, ...afterArrivals(2, "noted stop")],
    [X]: [[["spine_spawn", { tasks: [{ summary: "G1", prompt: "g1" }, { summary: "G2", prompt: "g2" }] }]], "waiting"],
    [Y]: ["y"],
    [G1]: [{ hang: true }],
    [G2]: [{ hang: true }],
  });
  try {
    const agent = await dsh.run("start");
    await until(() => ends(dsh, X).length === 1 && requestsOf(dsh, G1).length === 1 && requestsOf(dsh, G2).length === 1);
    if (typeof dsh.ctx.subagents.interruptByUser === "function") {
      dsh.ctx.subagents.interruptByUser(X);
    } else {
      dsh.ctx.agents.get(X).cancel({ kind: "user" }, { keepInbox: true });
    }
    const stopped = arrival("1.1.1", "aborted", "spawn child was cancelled");
    await until(() => requestsOf(dsh, "session-1").at(-1)?.includes(stopped));
    await agent.whenIdle();
    await until(() => ends(dsh, G1).length > 0 && ends(dsh, G2).length > 0);
    assert.deepEqual(ends(dsh, G1), ["aborted"]);
    assert.deepEqual(ends(dsh, G2), ["aborted"]);
    assert.equal(requestsOf(dsh, X).length, 2, "Stop does not wake X to process canceled descendant results");
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
      "user: go on",
    ].toSorted());
    assert.deepEqual(ends(dsh, "session-1"), ["aborted", "completed"]);
    assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await dsh.dispose();
  }
});

test("reloading Spine wakes an idle parent with the results of its cancelled children", { timeout: 10000 }, async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "received"],
    [X]: [{ hang: true }],
    [Y]: [{ hang: true }],
  });
  try {
    const parent = await dsh.run("start");
    await until(() => requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1);
    assert.deepEqual(ends(dsh, parent.id), ["completed"]);
    assert.equal(requestsOf(dsh, parent.id).length, 3);
    await reloadSpine(dsh, parent);
    await until(() => ends(dsh, parent.id).length === 2);
    await parent.whenIdle();

    const results = requestsOf(dsh, parent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival"));
    assert.deepEqual(results, [
      arrival("1.1.1", "aborted", "the parent session restarted before this child returned"),
      arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
    ]);
    assert.deepEqual(ends(dsh, parent.id), ["completed", "completed"]);
    for (const id of [X, Y]) {
      const [childRequest] = dsh.adapter.requests.filter((request) => request.sessionId === id);
      assert.equal(childRequest.signal.aborted, true);
    }
    assert.equal(requestsOf(dsh, parent.id).length, 4, "one batch wakes the parent for one turn");
    assert.equal(dsh.ctx.agents.get(X), undefined, "the old child has been disposed");
    assert.equal(dsh.ctx.agents.get(Y), undefined, "the old child has been disposed");
    assert.equal(parent.inbox.nextStep.length, 0);
    assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
  } finally {
    await dsh.dispose();
  }
});

test("reloading Spine wakes an idle parent whose waiting reply ran out of tokens", { timeout: 10000 }, async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, { text: "waiting", finish: "max-tokens" }, "received"],
    [X]: [{ hang: true }],
    [Y]: [{ hang: true }],
  });
  try {
    const parent = await dsh.run("start");
    await until(() => requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1);
    assert.deepEqual(ends(dsh, parent.id), ["max-tokens"]);
    await reloadSpine(dsh, parent);
    await until(() => ends(dsh, parent.id).length === 2);
    await parent.whenIdle();

    assert.equal(requestsOf(dsh, parent.id).length, 4, "one batch wakes the parent for one turn");
    assert.deepEqual(requestsOf(dsh, parent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival")), [
      arrival("1.1.1", "aborted", "the parent session restarted before this child returned"),
      arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
    ]);
    assert.deepEqual(ends(dsh, parent.id), ["max-tokens", "completed"]);
    assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
  } finally {
    await dsh.dispose();
  }
});

for (const stop of [false, true]) {
  test(`reloading during the parent's waiting reply ${stop ? "respects Stop" : "recovers on its first idle"}`, { timeout: 10000 }, async () => {
    const waiting = gate();
    const dsh = await mountDsh({
      "session-1": [[["spine_open", { goal: "A" }]], spawnXY, waiting.after("waiting"), "received", "received"],
      [X]: [{ hang: true }],
      [Y]: [{ hang: true }],
    });
    try {
      const run = dsh.run("start");
      await until(() => requestsOf(dsh, "session-1").length === 3 && requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1);
      const parent = dsh.agent;
      assert.equal(parent.status, "running");
      await reloadSpine(dsh, parent);
      assert.equal(parent.status, "running", "the waiting reply was in flight during remount");
      assert.deepEqual(ends(dsh, parent.id), []);
      if (stop) parent.cancel({ kind: "user" });
      waiting.open();
      await run;

      if (stop) {
        await until(() => dsh.ctx.agents.get(X) === undefined && dsh.ctx.agents.get(Y) === undefined);
        assert.deepEqual(ends(dsh, parent.id), ["aborted"]);
        assert.equal(requestsOf(dsh, parent.id).length, 3, "Stop leaves the parent idle");
        await dsh.send(parent, "continue");
      } else {
        await until(() => ends(dsh, parent.id).length === 2);
        await parent.whenIdle();
        assert.deepEqual(ends(dsh, parent.id), ["completed", "completed"]);
        assert.equal(requestsOf(dsh, parent.id).length, 4, "one batch wakes the parent for one turn");
      }
      assert.equal(ends(dsh, parent.id).at(-1), "completed");
      assert.deepEqual(requestsOf(dsh, parent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival")), [
        arrival("1.1.1", "aborted", "the parent session restarted before this child returned"),
        arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      ]);
      assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
    } finally {
      waiting.open();
      await dsh.dispose();
    }
  });
}

for (const stop of [false, true]) {
  test(`recovery waits for a completed child's log${stop ? " without overriding Stop" : " before waking the parent"}`, { timeout: 10000 }, async () => {
    const reply = gate();
    const stopping = gate();
    const dsh = await mountDsh({
      "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "received"],
      [X]: [reply.after("x is 42")],
      [Y]: [{ hang: true }],
    });
    let childStopping = false;
    dsh.ctx.on("agent/turn-stopping", ({ agent }) => {
      if (agent.id !== X) return;
      childStopping = true;
      return stopping.after()();
    });
    try {
      const parent = await dsh.run("start");
      reply.open();
      await until(() => childStopping && requestsOf(dsh, Y).length === 1);
      await reloadSpine(dsh, parent);
      assert.equal(requestsOf(dsh, parent.id).length, 3, "the old child still owns its log");
      if (stop) parent.cancel({ kind: "user" });
      stopping.open();
      await parent.whenIdle();

      if (stop) {
        assert.equal(requestsOf(dsh, parent.id).length, 3, "Stop wins over the background wake");
        assert.equal(parent.inbox.nextStep.length, 2, "the results are parked for later input");
        await dsh.send(parent, "continue");
      }
      const results = requestsOf(dsh, parent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival"));
      assert.deepEqual(results, [
        arrival("1.1.1", "completed", "x is 42"),
        arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      ]);
      assert.equal(requestsOf(dsh, parent.id).length, 4);
      assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
    } finally {
      reply.open();
      stopping.open();
      await dsh.dispose();
    }
  });
}

for (const rejections of [0, 2]) {
  test(`the first accepted input recovers child results after reload and ${rejections} rejected steps`, { timeout: 10000 }, async () => {
    const reply = gate();
    const stopping = gate();
    const dsh = await mountDsh({
      "session-1": [[["spine_open", { goal: "A" }]], spawnXY, { hang: true }, "received", "extra request"],
      [X]: [reply.after("completed before reload")],
      [Y]: [{ hang: true }],
    });
    let childStopping = false;
    dsh.ctx.on("agent/turn-stopping", ({ agent }) => {
      if (agent.id !== X) return;
      childStopping = true;
      return stopping.after()();
    });
    try {
      const run = dsh.run("start");
      await until(() => requestsOf(dsh, "session-1").length === 3 && requestsOf(dsh, Y).length === 1);
      reply.open();
      await until(() => childStopping);
      const parent = dsh.agent;
      parent.cancel({ kind: "user" });
      await run;
      assert.deepEqual(ends(dsh, parent.id), ["aborted"]);
      const child = dsh.ctx.agents.get(X);
      assert.ok(child);
      await reloadSpine(dsh, parent);

      let remaining = rejections;
      const reject = dsh.ctx.on("agent/pre-step", ({ messages }, next) => {
        if (remaining === 0 || !messages.some(({ source }) => source.kind === "user")) return next();
        remaining -= 1;
        return Promise.resolve({ kind: "reject" });
      });
      try {
        const continued = dsh.send(parent, rejections === 0 ? "continue" : "blocked first");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(dsh.ctx.agents.get(X), child, "the old child still owns the writer");
        assert.equal(requestsOf(dsh, parent.id).length, 3, "pre-step recovery waits for the writer to close");
        stopping.open();
        await continued;
        if (rejections > 0) {
          assert.equal(parent.inbox.nextStep.length, 2, "both results were requeued after the first rejection");
          await dsh.send(parent, "blocked again");
          assert.equal(parent.inbox.nextStep.length, 2, "each result was requeued once after the next rejection");
          assert.equal(requestsOf(dsh, parent.id).length, 3);
          await dsh.send(parent, "continue");
        }
      } finally {
        reject();
      }

      const continuedRequests = requestsOf(dsh, parent.id).slice(3);
      assert.equal(continuedRequests.length, 1, "the first request after reload already has the results");
      assert.ok(continuedRequests[0].includes("user: continue"));
      const results = continuedRequests[0].filter((line) => line.startsWith("user: <spine_arrival"));
      assert.deepEqual(results, [
        arrival("1.1.1", "completed", "completed before reload"),
        arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      ]);
      assert.deepEqual(ends(dsh, parent.id), ["aborted", ...Array(rejections).fill("blocked"), "completed"]);
      const producers = dsh.events(parent.id).flatMap((event) =>
        event.type === "user/message" && event.data.source.kind === "spine-arrival" ? [event.data.source.arrival.producer.join(".")] : []);
      assert.deepEqual(producers, ["1.1.1", "1.1.2"], "each result is logged once");
      assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
    } finally {
      reply.open();
      stopping.open();
      await dsh.dispose();
    }
  });
}

for (const stop of [false, true]) {
  test(`recovery parks arrivals after ${stop ? "stopping" : "releasing"} contended maintenance`, { timeout: 10000 }, async () => {
    const maintenance = gate();
    const dsh = await mountDsh({
      "session-1": [[["spine_open", { goal: "A" }]], spawnXY, "waiting", "received"],
      [X]: [{ hang: true }],
      [Y]: [{ hang: true }],
    });
    let held;
    let signal;
    try {
      const parent = await dsh.run("start");
      await until(() => requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1);
      held = parent.runMaintenance((active) => {
        signal = active;
        return maintenance.after()();
      });
      assert.equal(parent.status, "idle", "maintenance has no public running status");
      await reloadSpine(dsh, parent);
      await reloadSpine(dsh, parent);
      assert.equal(parent.inbox.nextStep.length, 0, "contended recovery has not delivered results");
      if (stop) parent.cancel({ kind: "user" }, { keepInbox: true });
      assert.equal(signal.aborted, stop);
      maintenance.open();
      await held;
      await until(() => parent.inbox.nextStep.length === 2);
      await parent.whenIdle();
      assert.equal(requestsOf(dsh, parent.id).length, 3, "unobserved maintenance completion never wakes the parent");
      assert.deepEqual(parent.inbox.nextStep.map(({ source }) => source.arrival.producer.join(".")), ["1.1.1", "1.1.2"]);
      assert.equal(dsh.ctx.agents.get(X), undefined);
      assert.equal(dsh.ctx.agents.get(Y), undefined);

      await dsh.send(parent, "continue");
      const results = requestsOf(dsh, parent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival"));
      assert.deepEqual(results, [
        arrival("1.1.1", "aborted", "the parent session restarted before this child returned"),
        arrival("1.1.2", "aborted", "the parent session restarted before this child returned"),
      ]);
      assert.equal(parent.inbox.nextStep.length, 0);
      assert.deepEqual(ends(dsh, parent.id), ["completed", "completed"]);
      assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages());
    } finally {
      maintenance.open();
      await held;
      await dsh.dispose();
    }
  });
}

test("a rejected step after reload does not lose or duplicate claimed Spawn arrivals", { timeout: 10000 }, async () => {
  const dsh = await mountDsh({
    "session-1": [[["spine_open", { goal: "A" }]], spawnXY, { hang: true }, "received"],
    [X]: [{ hang: true }],
    [Y]: [{ hang: true }],
  });
  try {
    const run = dsh.run("start");
    await until(() => requestsOf(dsh, X).length === 1 && requestsOf(dsh, Y).length === 1 && requestsOf(dsh, "session-1").length === 3);
    const agent = dsh.agent;
    agent.cancel({ kind: "user" });
    await run;
    await until(() => agent.inbox.nextStep.length === 2);
    await reloadSpine(dsh, agent);

    const reject = dsh.ctx.on("agent/pre-step", ({ messages }, next) => messages.some(({ source }) => source.kind === "spine-arrival")
      ? Promise.resolve({ kind: "reject" }) : next());
    try {
      await dsh.send(agent, "this step will be blocked");
      assert.equal(ends(dsh, agent.id).at(-1), "blocked");
      assert.equal(requestsOf(dsh, agent.id).length, 3);
    } finally {
      reject();
    }
    await dsh.send(agent, "continue after the rejection");
    const received = requestsOf(dsh, agent.id).at(-1).filter((line) => line.startsWith("user: <spine_arrival")).toSorted();
    assert.equal(received.length, 2);
    assert.match(received[0], /1\.1\.1/);
    assert.match(received[1], /1\.1\.2/);
    assert.equal(ends(dsh, agent.id).at(-1), "completed");
  } finally {
    await dsh.dispose();
  }
});

for (const mode of ["warm", "restart", "rejected"]) {
  test(`Stop cancels an accepted Spawn still queued behind another tool (${mode})`, async () => {
    const first = await mountDsh({
      "session-1": [[["spine_open", { goal: "A" }]], [...spawnXY, ["stop_probe", {}]], "changed direction", "noted"],
      [X]: ["obsolete X result"],
      [Y]: ["obsolete Y result"],
    });
    let resumed;
    try {
      let toolStarted;
      const started = new Promise((resolve) => { toolStarted = resolve; });
      first.ctx.tools.register({
        name: "stop_probe",
        description: "Wait for Stop",
        parameters: { type: "object", properties: {} },
        output: { schema: { type: "object", properties: {} }, render: () => [] },
        async execute(_args, { signal }) {
          toolStarted();
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          signal.throwIfAborted();
          return {};
        },
      });
      const run = first.run("check login");
      await started;
      assert.ok(first.events(first.agent).some((event) => event.type === "tool/result"
        && event.data.message.isError !== true
        && event.data.message.content.some((block) => block.type === "text" && block.text.includes("Spine Spawn accepted"))));
      first.agent.cancel({ kind: "user" });
      await run;
      assert.deepEqual(ends(first, "session-1"), ["aborted"]);
      assert.deepEqual(first.adapter.requests.map((request) => request.sessionId), ["session-1", "session-1"]);

      let dsh = first;
      let parent = first.agent;
      if (mode === "restart") {
        resumed = await mountDsh(["changed direction", "noted"], { root: await first.crashed() });
        dsh = resumed;
        parent = await resumed.resume(parent.id);
        assert.equal(dsh.adapter.requests.length, 0, "recovered arrivals do not wake the parent");
      }
      const before = dsh.adapter.requests.length;
      if (mode === "rejected") {
        const reject = dsh.ctx.on("agent/pre-step", () => ({ kind: "reject" }));
        try {
          for (const prompt of ["blocked followup", "blocked again"]) {
            await dsh.send(parent, prompt);
            assert.equal(dsh.adapter.requests.length, before);
            assert.equal(ends(dsh, "session-1").at(-1), "blocked");
            assert.equal(parent.inbox.nextStep.filter(({ source }) => source.kind === "spine-arrival").length, 2);
          }
        } finally {
          reject();
        }
      }
      await dsh.send(parent, "check the homepage instead");
      assert.deepEqual(dsh.adapter.requests.filter((request) => request.sessionId !== "session-1"), [], "no obsolete child starts");
      const [request] = dsh.adapter.requests.slice(before).map(shown);
      assert.equal(dsh.adapter.requests.length, before + 1, "the next admitted request handles both the cancellations and the new user input");
      assert.ok(request.includes("user: check the homepage instead"));
      assert.deepEqual(request.filter((line) => line.startsWith("user: <spine_arrival")), [
        arrival("1.1.1", "aborted", mode === "restart" ? "the parent session restarted before this child returned" : "spawn child was cancelled"),
        arrival("1.1.2", "aborted", mode === "restart" ? "the parent session restarted before this child returned" : "spawn child was cancelled"),
      ]);
      const arrivals = dsh.events(parent).filter((event) => event.type === "user/message" && event.data.source.kind === "spine-arrival");
      assert.deepEqual(arrivals.map(({ data }) => [data.source.arrival.producer.join("."), data.source.arrival.outcome]), [
        ["1.1.1", "aborted"], ["1.1.2", "aborted"],
      ]);
      assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages(), "aborted results persist exactly once");
    } finally {
      first.agent?.cancel({ kind: "user" });
      await resumed?.dispose();
      await first.dispose();
    }
  });
}

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
    assert.equal(request.at(-1), "user: continue");
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
    assert.deepEqual(last.slice(-3), [memory("1.1", "m"), "assistant: x is 42, y is 7", "user: thanks"], "the memory ends the folded node");
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
