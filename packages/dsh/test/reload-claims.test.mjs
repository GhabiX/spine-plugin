// Regression: background recovery can park results before a later step claims
// them. Rejection must not lose those claims merely because Spine is attached.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mountDsh, reloadSpine } from "./harness.mjs";

const X = "session-1:spawn:1.1.1";
const Y = "session-1:spawn:1.1.2";
const G1 = `${X}:spawn:1.1.1`;
const G2 = `${X}:spawn:1.1.2`;
const spawn = (names) => [["spine_spawn", { tasks: names.map((summary) => ({ summary, prompt: summary })) }]];
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { open, promise };
}
async function until(condition) {
  const end = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < end, "condition never held");
    await sleep(5);
  }
}

for (const nested of [false, true]) {
  for (const rejections of [1, 2]) {
    test(`parked reload arrivals survive ${rejections} rejected steps${nested ? " with nested maintenance" : ""}`, { timeout: 10000 }, async () => {
      const reply = gate();
      const drain = gate();
      let draining = false;
      const dsh = await mountDsh({
        "session-1": [[["spine_open", { goal: "keep recovered claims" }]], spawn(["X", "Y"]), "waiting", "received once"],
        [X]: nested ? [spawn(["G1", "G2"]), "waiting for grandchildren"] : [async () => { await reply.promise; return "completed X"; }],
        [Y]: [{ hang: true }],
        [G1]: [{ hang: true }],
        [G2]: [{ hang: true }],
      });
      const requests = (id) => dsh.adapter.requests.filter((request) => request.sessionId === id);
      if (!nested) {
        dsh.ctx.on("agent/turn-stopping", ({ agent }) => {
          if (agent.id !== X) return;
          draining = true;
          return drain.promise;
        });
      }
      try {
        const parent = await dsh.run("start");
        if (nested) {
          await until(() => requests(G1).length === 1 && requests(G2).length === 1 && requests(Y).length === 1);
          const child = dsh.ctx.agents.get(X);
          await until(() => child.status === "idle");
          await sleep(30);
          assert.equal(dsh.ctx.agents.get(X) === child, true, "nested activation stays available");
          child.ctx.effect(() => async () => { draining = true; await drain.promise; });
        } else {
          reply.open();
          await until(() => draining);
        }
        await reloadSpine(dsh, parent);
        await until(() => draining);
        assert.equal(requests(parent.id).length, 3, "recovery waits for the old writer");
        parent.cancel({ kind: "user" });
        drain.open();
        await parent.whenIdle();
        await until(() => parent.inbox.nextStep.length === 2);
        const childIds = nested ? [X, Y, G1, G2] : [X, Y];
        await until(() => childIds.every((id) => dsh.ctx.agents.get(id) === undefined));
        const childRequests = childIds.map((id) => requests(id).length);
        assert.equal(requests(parent.id).length, 3, "Stop wins over the background wake");

        for (let index = 0; index < rejections; index += 1) {
          const reject = dsh.ctx.on("agent/pre-step", () => ({ kind: "reject" }));
          try { await dsh.send(parent, `rejected-${index}`); } finally { reject(); }
          assert.equal(requests(parent.id).length, 3);
          assert.equal(parent.inbox.nextStep.length, 2, "claimed results are parked again, not lost");
          // The two-rejection cases also cross a second plugin reload.
          if (rejections === 2 && index === 0) await reloadSpine(dsh, parent);
        }
        await dsh.send(parent, "fresh accepted input");
        assert.equal(requests(parent.id).length, 4, "one request receives both results and new input");
        const arrivals = requests(parent.id).at(-1).messages.filter(({ source }) => source.kind === "spine-arrival");
        const logged = parent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "spine-arrival");
        const expected = [["1.1.1", nested ? "aborted" : "completed"], ["1.1.2", "aborted"]];
        assert.deepEqual(arrivals.map(({ source }) => [source.arrival.producer.join("."), source.arrival.outcome]), expected);
        assert.deepEqual(logged.map(({ data }) => [data.source.arrival.producer.join("."), data.source.arrival.outcome]), expected);
        assert.equal(parent.inbox.nextStep.length, 0);
        assert.deepEqual(childIds.map((id) => requests(id).length), childRequests, "old children never restart");
        assert.deepEqual(await dsh.restored(parent), parent.session.deriveMessages(), "exactly-once results persist");
        await sleep(30);
        assert.equal(requests(parent.id).length, 4, "no delayed duplicate wake");
      } finally {
        reply.open();
        drain.open();
        await dsh.dispose();
      }
    });
  }
}
