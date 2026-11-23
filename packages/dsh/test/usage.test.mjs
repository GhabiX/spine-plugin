import assert from "node:assert/strict";
import test from "node:test";
import { SpineRuntimeClient } from "@spinejit/spine-sdk";

import { mountDsh } from "./harness.mjs";

// Observe the request to the actual SDK without replacing its execution.
test("live and resumed samplings include cached input in the Spine token count", async (t) => {
  const settled = [];
  const execute = SpineRuntimeClient.prototype.execute;
  t.mock.method(SpineRuntimeClient.prototype, "execute", async function (command) {
    if (command.type === "prepare_finish") settled.push(command);
    return execute.call(this, command);
  });

  const first = await mountDsh([
    { text: "read", usage: { inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 5 } },
    { text: "write", usage: { inputTokens: 100, cacheWriteTokens: 800, outputTokens: 10 } },
    { text: "both", usage: { inputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 60, outputTokens: 7 } },
    { text: "zero", usage: { inputTokens: 0, outputTokens: 1 } },
    "unreported",
  ]);
  let id;
  try {
    const agent = await first.run("cache read");
    id = agent.id;
    for (const text of ["cache write", "read and write", "no input", "no usage"]) await first.send(agent, text);
    assert.deepEqual(settled.map((command) => command.input_tokens), [10_000, 900, 120, 0]);
  } finally {
    await first.dispose();
  }

  settled.length = 0;
  const reopened = await mountDsh(["continued"], { root: first.root });
  try {
    const agent = await reopened.resume(id);
    assert.deepEqual(settled.map((command) => command.input_tokens), [10_000, 900, 120, 0, undefined]);
    assert.equal(Object.hasOwn(settled[4], "input_tokens"), false);
    assert.equal(reopened.adapter.requests.length, 0);
    await reopened.send(agent, "continue");
    assert.equal(reopened.adapter.requests.length, 1);
  } finally {
    await reopened.dispose();
  }
});
