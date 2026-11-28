// Shared fixtures for the Spine compaction tests.
import assert from "node:assert/strict";
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from "@deepseek-ai/dsh-llm";

import { mountDsh } from "./harness.mjs";

const PLUGIN = new URL("../dist/index.js", import.meta.url).href;
const ENGINE = new URL("../dist/compact.js", import.meta.url).href;

/** A world with the bundle's two rows: Spine and its compaction service. */
export async function mountCompact(replies, options = {}, rows = [{ id: "spinejit-compact", name: ENGINE }]) {
  const dsh = await mountDsh(replies, options);
  await dsh.ctx.loader.root.update([{ id: "spinejit", name: PLUGIN }, ...rows]);
  await dsh.ctx.loader.await();
  return dsh;
}

/** The provider rejects the request for exceeding the model's context window. */
export const overflow = () => {
  throw new LlmError("This model's maximum context length is 16384 tokens", CONTEXT_WINDOW_EXCEEDED_CODE);
};

/** Answer one summarization request with `text`. */
export const summary = (text) => (request) => {
  assert.equal(request.purpose, "compaction");
  return text;
};

export const checkpoints = (agent) => agent.session.snapshotEvents()
  .filter((event) => event.type === "user/message" && event.data.source.kind === "spine-compact");
export const ends = (agent) => agent.session.snapshotEvents()
  .filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind);
export const text = (request) => request.messages
  .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text)).join("\n");
