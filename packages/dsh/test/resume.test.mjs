// A restarted process resumes a persisted session: Spine state comes back from
// the session log alone, and the next request still shows the plan.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { mountDsh, reloadSpine } from "./harness.mjs";
import { call, memory, numbered, shown, result, closed } from "./shown.mjs";

/** Run `before` in one world, then resume the same session in a new one and run `after`. */
async function restart(before, after, drive) {
  const first = await mountDsh(before);
  let id;
  try {
    id = (await first.run("start")).id;
  } finally {
    await first.dispose();
  }
  const second = await mountDsh(after, { root: first.root });
  try {
    const agent = await second.resume(id);
    await drive(second, agent);
    assert.deepEqual(await second.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
    return {
      requests: second.adapter.requests.map(shown),
      ends: agent.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind),
    };
  } finally {
    await second.dispose();
  }
}

test("a resumed session keeps its open node, user numbering and Close", async () => {
  const run = await restart(
    [[["spine_open", { goal: "A" }]], "replyA"],
    [[["spine_close", { memory: "memA" }]], "done", "ok"],
    async (dsh, agent) => {
      await dsh.send(agent, "more");
      await dsh.send(agent, "last");
    },
  );
  assert.deepEqual(run.ends, ["completed", "completed", "completed"]);
  const before = ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), result("spine_open", "1.1", "A"), "assistant: replyA", "user: more"];
  assert.deepEqual(run.requests, [
    before,
    [...numbered(before, 2, "more"), call("spine_close", { memory: "memA" }), result("spine_close")],
    ["user: [U1]\nstart", "context: …", closed("1.1", "A"), "assistant: replyA", "user: [U2]\nmore", memory("1.1", "memA"), "assistant: done", "user: last"],
  ]);
});

test("reloading Spine reattaches existing agents before their next model request", async () => {
  const first = await mountDsh([
    [["spine_open", { goal: "A" }]], "before reload",
    [["spine_close", { memory: "memA" }]], "after first reload",
    "after second reload",
  ]);
  let id;
  try {
    const agent = await first.run("start");
    id = agent.id;
    await reloadSpine(first, agent);
    await first.send(agent, "after reload");
    await reloadSpine(first, agent);
    await first.send(agent, "again");

    const events = agent.session.snapshotEvents();
    const anchors = events.filter((event) => event.type === "plugin:spinejit/user-anchors")
      .flatMap((event) => event.data.anchors.map(({ anchor }) => anchor));
    assert.deepEqual(anchors, [1, 2, 3]);
    assert.equal(first.adapter.requests.length, 5);
    assert.ok(first.adapter.requests.map(shown).at(-2).includes(result("spine_close")));
    assert.ok(first.adapter.requests.map(shown).at(-1).includes(memory("1.1", "memA")));
    assert.deepEqual(ends(agent), ["completed", "completed", "completed"]);
  } finally {
    await first.dispose();
  }
  const second = await mountDsh(["after restart"], { root: first.root });
  try {
    const agent = await second.resume(id);
    await second.send(agent, "resume after reload");
    assert.deepEqual(ends(agent), ["completed", "completed", "completed", "completed"]);
    assert.ok(second.adapter.requests.map(shown)[0].includes("user: [U3]\nagain"));
    assert.deepEqual(await second.restored(agent), agent.session.deriveMessages());
  } finally {
    await second.dispose();
  }
});

test("a tool can await a Spine reload during a turn without losing the next sampling", { timeout: 5000 }, async () => {
  const dsh = await mountDsh([
    [["spine_open", { goal: "A" }]], "before reload",
    [["reload_spine", {}]],
    [["spine_close", { memory: "memA" }]], "after reload",
  ]);
  try {
    const agent = await dsh.run("start");
    dsh.ctx.tools.register({
      name: "reload_spine",
      description: "Remount SpineJIT with the current agent still running.",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: {} }, render: () => [{ type: "text", text: "reloaded" }] },
      execute: async () => { await reloadSpine(dsh, agent); return {}; },
    });
    await dsh.send(agent, "reload now");
    const requests = dsh.adapter.requests.map(shown);
    assert.ok(requests.at(-2).includes("tool: reloaded"));
    assert.ok(requests.at(-1).includes(result("spine_close")));
    assert.ok(requests.at(-1).includes("user: [U2]\nreload now"));
    assert.deepEqual(ends(agent), ["completed", "completed"]);
  } finally {
    await dsh.dispose();
  }
});

test("a failed sampling replays as failed: the Open it staged is not committed", async () => {
  const run = await restart(
    [[["spine_open", { goal: "A" }]], { fail: "boom" }],
    ["ok"],
    (dsh, agent) => dsh.send(agent, "again"),
  );
  assert.deepEqual(run.ends, ["error", "completed"]);
  assert.deepEqual(run.requests, [
    ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), result("spine_open", "1.1", "A"), "user: again"],
  ]);
});

for (const cut of ["user message", "user anchor", "sampling marker"]) {
  test(`a crash after persisting the ${cut} preserves the pending user message`, async () => {
    const first = await mountDsh([[["spine_open", { goal: "A" }]], "initial reply", "reply lost to crash"]);
    let root;
    let id;
    let pendingSeq;
    try {
      const agent = await first.run("start");
      id = agent.id;
      await first.send(agent, "pending");
      root = await first.crashed();
      const dir = join(root, "sessions");
      const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
      assert.equal(files.length, 1);
      const path = join(dir, files[0]);
      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line));
      const user = events.findIndex((event) => event.type === "user/message" && event.data.content.some((block) => block.text === "pending"));
      const anchor = events.findIndex((event, i) => i > user && event.type === "plugin:spinejit/user-anchors");
      const marker = events.findIndex((event, i) => i > anchor && event.type === "developer/message" && event.data.message.source.sampling === true);
      assert.ok(user > 0 && anchor > user && marker > anchor, "the log contains all three crash points in order");
      pendingSeq = events[user].seq;
      const last = { "user message": user, "user anchor": anchor, "sampling marker": marker }[cut];
      await writeFile(path, lines.slice(0, last + 1).join("\n") + "\n");
    } finally {
      await first.dispose();
    }

    const second = await mountDsh(["replied after restart"], { root });
    try {
      const agent = await second.resume(id);
      await second.send(agent, "continue");
      assert.equal(second.adapter.requests.length, 1, "the first post-restart request reaches the model");
      assert.deepEqual(shown(second.adapter.requests[0]).filter((line) => line.startsWith("user: ")), [
        "user: [U1]\nstart",
        cut === "user message" ? "user: pending" : "user: [U2]\npending",
        "user: continue",
      ]);
      assert.ok(agent.session.surface.nodes.includes(pendingSeq), "the pending source stays on the surface");
      assert.equal(ends(agent).at(-1), "completed");
      assert.deepEqual(await second.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
    } finally {
      await second.dispose();
    }
  });
}

test("a session dsh-spinejit 0.1.1 logged, with [U<n>] in the user text, resumes numbering each user message once", async () => {
  const first = await mountDsh([[["spine_open", { goal: "A" }]], "replyA"]);
  try {
    await first.run("start");
  } finally {
    await first.dispose();
  }
  assert.equal(await asLoggedBy011(first.root), 1, "one user message rewritten");
  const second = await mountDsh([[["spine_close", { memory: "memA" }]], "done"], { root: first.root });
  try {
    const agent = await second.resume("session-1");
    await second.send(agent, "[U2]\nmore");
    const before = ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), result("spine_open", "1.1", "A"), "assistant: replyA"];
    assert.deepEqual(second.adapter.requests.map(shown), [
      [...before, "user: [U2]\nmore"],
      [...before, "user: [U2]\n[U2]\nmore", call("spine_close", { memory: "memA" }), result("spine_close")],
    ]);
    assert.deepEqual(ends(agent), ["completed", "completed"]);
    assert.deepEqual(await second.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
  } finally {
    await second.dispose();
  }
});

/**
 * Rewrite the logs under `root` as dsh-spinejit 0.1.1 wrote them: each number
 * in the user text, no user-anchors record (an ignorable record of no plugin
 * keeps the seqs). Returns how many user messages it numbered.
 */
async function asLoggedBy011(root) {
  let rewritten = 0;
  const files = (await readdir(join(root, "sessions"), { recursive: true })).filter((name) => name.endsWith(".jsonl"));
  for (const name of files) {
    const path = join(root, "sessions", name);
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const anchors = new Map(lines.filter((line) => line.type === "plugin:spinejit/user-anchors")
      .flatMap((line) => line.data.anchors.map(({ seq, anchor }) => [seq, anchor])));
    for (const line of lines) {
      if (line.type === "plugin:spinejit/user-anchors") line.type = "plugin:test/none";
      if (line.type === "user/message" && anchors.has(line.seq)) {
        const block = line.data.content.find((item) => item.type === "text");
        block.text = `[U${anchors.get(line.seq)}]\n${block.text}`;
        rewritten += 1;
      }
    }
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  return rewritten;
}

for (const repaired of [true, false]) {
  test(repaired ? "a repaired inline anchor without a sampling marker resumes" : "an already pasted number without a sampling marker does not pass for a repair", async () => {
    const text = repaired ? "second question" : "[U2]\nsecond question";
    const first = await mountDsh(["first reply", "second reply"]);
    try {
      const agent = await first.run("start");
      await first.send(agent, text);
    } finally {
      await first.dispose();
    }
    await withoutSecondSampling(first.root, repaired);
    const second = await mountDsh(["resumed reply"], { root: first.root });
    try {
      if (!repaired) {
        await assert.rejects(second.resume("session-1"), /started without Spine/);
        return;
      }
      const agent = await second.resume("session-1");
      await second.send(agent, "continue");
      assert.equal(agent.session.snapshotEvents().filter((line) => line.type === "turn/end").at(-1).data.reason.kind, "completed",
        JSON.stringify(agent.session.snapshotEvents().filter((line) => line.type === "turn/end").at(-1).data.reason));
      assert.deepEqual(second.adapter.requests.map(shown), [
        ["user: [U1]\nstart", "context: …", "assistant: first reply", "user: [U2]\nsecond question", "assistant: second reply", "user: continue"],
      ]);
      assert.deepEqual(ends(agent), ["completed", "completed", "completed"]);
    } finally {
      await second.dispose();
    }
  });
}

/** Model a reply logged without Spine and an optional inline repair after the fact. */
async function withoutSecondSampling(root, repaired) {
  const files = (await readdir(join(root, "sessions"), { recursive: true })).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const path = join(root, "sessions", files[0]);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const [, user] = lines.filter((line) => line.type === "user/message" && line.data.source.kind === "user");
  const assistant = lines.find((line) => line.seq > user.seq && line.type === "assistant/message");
  const numbering = lines.find((line) => line.type === "plugin:spinejit/user-anchors" && line.data.anchors.some((item) => item.seq === user.seq));
  assert.ok(numbering);
  numbering.type = "plugin:test/none";
  const markers = lines.filter((line) => line.seq > user.seq && line.seq < assistant.seq
    && line.type === "developer/message" && line.data.message.source.kind === "spine");
  assert.ok(markers.some((line) => line.data.message.source.sampling));
  for (const line of markers) {
    line.type = "plugin:test/none";
    line.ignorable = true;
    delete line.surfaceOp;
  }
  if (repaired) user.data.content[0].text = `[U2]\n${user.data.content[0].text}`;
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

test("literal [U<n>] lines keep their text and receive independent anchors across restart", async () => {
  const different = "[U7]\npasted opening";
  const equal = "[U2]\npasted follow-up";
  const { continuous, restarted } = await bothWays([
    [different, ["first reply"]],
    [equal, ["second reply"]],
    ["last", ["done"]],
  ]);
  assert.deepEqual(restarted, continuous);
  assert.deepEqual(continuous.ends, ["completed", "completed", "completed"]);
  const users = (request) => request.filter((line) => line.startsWith("user: "));
  assert.deepEqual(users(continuous.requests[0]), [`user: ${different}`]);
  assert.deepEqual(users(continuous.requests[1]), [`user: [U1]\n${different}`, `user: ${equal}`]);
  assert.deepEqual(users(continuous.requests[2]), [`user: [U1]\n${different}`, `user: [U2]\n${equal}`, "user: last"]);
});

test("a session that started without Spine is refused even if the user wrote a matching [U<n>]", async () => {
  const first = await mountDsh(["hello"], { plugin: false });
  let id;
  try {
    id = (await first.run("[U1]\nhi")).id;
  } finally {
    await first.dispose();
  }
  const second = await mountDsh([], { root: first.root });
  try {
    await assert.rejects(second.resume(id), /started without Spine/);
  } finally {
    await second.dispose();
  }
});

/**
 * Run `turns` in one world, and again in a new world before every turn that
 * resumes the session; `setup` prepares each world.
 */
async function bothWays(turns, setup = () => {}) {
  const once = await mountDsh(turns.flatMap(([, replies]) => replies));
  setup(once);
  let continuous;
  try {
    const agent = await once.run(turns[0][0]);
    for (const [text] of turns.slice(1)) await once.send(agent, text);
    continuous = { requests: once.adapter.requests.map(shown), ends: ends(agent) };
  } finally {
    await once.dispose();
  }

  const requests = [];
  let root;
  let id;
  let last;
  for (const [index, [text, replies]] of turns.entries()) {
    const dsh = await mountDsh(replies, { root });
    setup(dsh);
    try {
      if (index === 0) {
        id = (await dsh.run(text)).id;
      } else {
        const agent = await dsh.resume(id);
        await dsh.send(agent, text);
        last = ends(agent);
        assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages(), "official JSONL restore without Spine");
      }
      requests.push(...dsh.adapter.requests.map(shown));
      root = dsh.root;
    } finally {
      await dsh.dispose();
    }
  }
  return { continuous, restarted: { requests, ends: last } };
}

test("restarting before every turn changes nothing the model sees", async () => {
  const { continuous, restarted } = await bothWays([
    ["start", [[["spine_open", { goal: "A" }]], "r1"]],
    ["more", [[["spine_next", { memory: "mA", goal: "B" }]], { fail: "boom" }]],
    ["again", [{ text: "cut", finish: "max-tokens" }]],
    ["last", [[["spine_open", { goal: "C" }]], [["spine_close", { memory: "mC" }]], [["spine_close", { memory: "mB" }]], "done"]],
  ]);
  assert.deepEqual(continuous.ends, ["completed", "error", "max-tokens", "completed"]);
  assert.deepEqual(restarted, continuous);
});

test("a Spine call whose result another extension turns into an error commits nothing", async () => {
  const { continuous, restarted } = await bothWays(
    [["start", [[["spine_open", { goal: "A" }]], "done"]], ["more", ["ok"]]],
    (dsh) => dsh.ctx.on("tools/post-execute", (exec, result, next) => exec.name === "spine_open"
      ? Promise.resolve({ kind: "block", feedback: [{ type: "text", text: "blocked" }] })
      : next()),
  );
  assert.deepEqual(restarted, continuous);
  assert.deepEqual(continuous.requests[1], ["user: [U1]\nstart", "context: …", call("spine_open", { goal: "A" }), "tool: blocked"]);
  assert.ok(!continuous.requests.flat().some((item) => item.includes('status="opened"')));
});

test("a Stop after the response was logged: live and resumed sessions agree, and its reply survives Close", async () => {
  const { continuous, restarted } = await bothWays(
    [
      ["start", [[["spine_open", { goal: "A" }]], "replyA"]],
      ["more", [[["spine_close", { memory: "mA" }]], "done"]],
      ["last", ["ok"]],
    ],
    (dsh) => dsh.ctx.on("agent/turn-stopping", ({ agent }) => {
      const last = agent.session.snapshotEvents().findLast((event) => event.type === "assistant/message");
      if (last.data.message.content[0].text === "replyA") agent.cancel({ kind: "user" });
    }),
  );
  assert.deepEqual(continuous.ends, ["aborted", "completed", "completed"]);
  assert.deepEqual(restarted, continuous);
  assert.ok(continuous.requests.at(-1).includes(memory("1.1", "mA")), "the node folded");
  assert.ok(continuous.requests.at(-1).includes("assistant: replyA"));
});

test("a stream that ends without a finish chunk stopped by itself: its reply survives Close", async () => {
  const { continuous, restarted } = await bothWays([
    ["start", [[["spine_open", { goal: "A" }]], { text: "replyA", finish: null }]],
    ["more", [[["spine_close", { memory: "mA" }]], "done"]],
    ["last", ["ok"]],
  ]);
  assert.deepEqual(restarted, continuous);
  assert.deepEqual(continuous.requests.at(-2), [...numbered(continuous.requests.at(-3), 2, "more"), call("spine_close", { memory: "mA" }), result("spine_close")]);
  assert.deepEqual(continuous.requests.at(-1), [
    "user: [U1]\nstart", "context: …", closed("1.1", "A"), "assistant: replyA", "user: [U2]\nmore", memory("1.1", "mA"),
    "assistant: done", "user: last",
  ]);
});

function ends(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind);
}
