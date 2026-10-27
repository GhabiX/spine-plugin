import assert from "node:assert/strict";
import test from "node:test";

import { SPINE_CHILD_RETURN_TOOL, spineChildAssignmentText } from "../dist/host/render.js";

test("child assignment names identity, peers, descendant tools, and typed return", () => {
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
  assert.match(text, new RegExp(`${SPINE_CHILD_RETURN_TOOL} exactly once`));
  assert.match(text, /Assignment:\nreturn TOKEN_A$/);
});
