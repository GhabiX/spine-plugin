import assert from "node:assert/strict";
import test from "node:test";

import { hasReasoning } from "../dist/reasoning.js";

const output = (replayState) => ({
  role: "assistant",
  content: [{ type: "reasoning", text: "why" }, { type: "tool-call", id: "c1", name: "read", arguments: "{}" }],
  source: { kind: "model", provider: "p", model: "m", ...(replayState === undefined ? {} : { replayState }) },
});
const piAi = (api) => ({ response: { kind: "pi-ai", version: 2, api, provider: "p", model: "m" }, blocks: [{ type: "reasoning" }, { type: "tool-call", thoughtSignature: "sig" }] });

test("an output's reasoning is dropped for WithoutReasoning unless Gemini produced it: Gemini requires its signatures", () => {
  assert.equal(hasReasoning(output(undefined)), true);
  assert.equal(hasReasoning(output(piAi("openai-responses"))), true);
  assert.equal(hasReasoning(output(piAi("google-generative-ai"))), false);
  assert.equal(hasReasoning({ ...output(undefined), content: [{ type: "text", text: "done" }] }), false);
});
