import assert from "node:assert/strict";
import test from "node:test";

import { spineChildAssignmentText } from "../dist/host/render.js";

test("child assignment names identity, peers, descendant tools, and its final reply as the return", () => {
  const text = spineChildAssignmentText(
    { summary: "ALPHA", prompt: "return TOKEN_A" },
    [
      { summary: "ALPHA", prompt: "return TOKEN_A" },
      { summary: "BETA", prompt: "return TOKEN_B" },
    ],
  );
  assert.match(text, /You are: ALPHA/);
  assert.match(text, /^- BETA$/m);
  assert.doesNotMatch(text, /^- ALPHA$/m);
  assert.match(text, /already an active branch scope/);
  assert.match(text, /spine_open/);
  assert.match(text, /spine_close/);
  assert.match(text, /spine_next/);
  assert.match(text, /spine_spawn/);
  assert.match(text, /independent parallel sub-assignments/);
  assert.match(text, /ending with a final reply that holds the complete continuation memory/);
  assert.match(text, /Assignment:\nreturn TOKEN_A$/);
});
