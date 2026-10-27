import assert from "node:assert/strict";
import test from "node:test";

import { mountDsh } from "./harness.mjs";

test("the Loader mounts the plugin and the loop runs and restores", async () => {
  const dsh = await mountDsh(["hello"]);
  try {
    const entry = [...dsh.ctx.loader.entries()].find((candidate) => candidate.options.id === "spinejit");
    assert.equal(entry?.fiber?.state, 2, "the plugin fiber is active");
    const agent = await dsh.run("hi");
    assert.equal(dsh.adapter.requests.length, 1);
    const messages = agent.session.deriveMessages();
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant"]);
    assert.deepEqual(await dsh.restored(agent), messages);
  } finally {
    await dsh.dispose();
  }
});
