import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as ImageOffload from "@deepseek-ai/dsh-compaction-image-offload";
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, requiredImageOffload } from "@deepseek-ai/dsh-llm";

import { mountDsh } from "./harness.mjs";

const previews = Array.from({ length: 5 }, (_, index) => ({
  type: "image",
  attachment: {
    attachmentId: (index + 1).toString(16).padStart(64, "0"),
    mediaType: "image/png",
    bytes: 64,
    width: 1,
    height: 1,
  },
}));

const previewTool = {
  name: "preview",
  description: "Produce a batch of image previews.",
  parameters: { type: "object", properties: {} },
  output: { schema: { type: "object", properties: {} }, render: () => previews },
  execute: async () => ({}),
};

function enforceBudget(request) {
  // Match the provider preflight without making a network request.
  const offloadImages = requiredImageOffload(request.messages, { representation: "base64", maxImages: 3 }, block => block.attachment.bytes);
  if (offloadImages > 0) {
    throw new LlmError("Test route image budget exceeded", IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
  }
  return "within budget";
}

function imageBlocks(messages) {
  return messages.flatMap(message => message.content.filter(block => block.type === "image"));
}

const offloadEvents = events => events.filter(event => event.type === "image/offload");

test("the SpineJIT bundle leaves the host's image-offload setting alone", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.doesNotMatch(patch, /^\s*-\s+id:\s+['"]?image-offload\b/m);
});

test("native image offload lets a Spine request retry and preserves the decision across restart", async () => {
  const dsh = await mountDsh([
    [["spine_open", { goal: "inspect previews" }]],
    [["preview", {}]],
    enforceBudget,
    enforceBudget,
  ]);
  const root = dsh.root;
  const offload = dsh.ctx.plugin(ImageOffload);
  try {
    await offload.await();
    dsh.ctx.tools.register(previewTool);
    const agent = await dsh.run("inspect the previews");
    const events = dsh.events(agent);
    const preview = events.find(event => event.type === "tool/result" && imageBlocks([event.data.message]).length > 0);
    assert.ok(preview, "preview tool should return images");
    const end = events.findLast(event => event.type === "turn/end");
    assert.equal(end.data.reason.kind, "completed", JSON.stringify(end.data.reason));
    assert.deepEqual(offloadEvents(events).map(event => event.data.targets), [[{ seq: preview.seq, imageIndexes: [0, 1] }]]);
    const [failed, retried] = dsh.adapter.requests.slice(-2);
    assert.deepEqual(imageBlocks(failed.messages), previews);
    assert.deepEqual(imageBlocks(retried.messages), previews.map((block, index) => index < 2 ? { ...block, offloaded: true } : block));
    assert.deepEqual(preview.data.message.content, previews);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages());
  } finally {
    await dsh.dispose();
  }

  const restored = await mountDsh([enforceBudget], { root });
  try {
    await restored.ctx.plugin(ImageOffload).await();
    const agent = await restored.resume("session-1");
    await restored.send(agent, "continue");
    assert.equal(restored.events(agent).findLast(event => event.type === "turn/end").data.reason.kind, "completed");
    assert.equal(restored.adapter.requests.length, 1);
    assert.equal(imageBlocks(restored.adapter.requests[0].messages).filter(block => block.offloaded).length, 2);
    assert.equal(offloadEvents(agent.session.snapshotEvents()).length, 1);
  } finally {
    await restored.dispose();
  }
});
