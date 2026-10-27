import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = process.argv[2];
if (modulePath === undefined) {
  throw new Error("usage: node scripts/verify-wasm-golden.mjs <generated-node-module>");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = JSON.parse(
  await readFile(resolve(root, "fixtures/conformance/portable-runtime-golden.json"), "utf8"),
);
const require = createRequire(import.meta.url);
const { SpineRuntime } = require(resolve(modulePath));
const runtime = new SpineRuntime(JSON.stringify(fixture.init));
const outputs = fixture.requests.map((request) => JSON.parse(runtime.dispatch(JSON.stringify(request))));
const transactionId = outputs[3].result.transaction_id;
outputs.push(
  JSON.parse(
    runtime.dispatch(
      JSON.stringify({
        schema: "spine-sdk/v3",
        request: { type: "install_prepared", transaction_id: transactionId },
      }),
    ),
  ),
);

const expected = fixture.expected;
assert.deepEqual(outputs[0].result.source_ids[0], expected.first_source_id);
assert.deepEqual(outputs[1].result.record.record.attempt_id, expected.started_attempt_id);
assert.deepEqual(outputs[2].result.source_ids[0], expected.second_source_id);
assert.equal(outputs[3].result.transaction_id, expected.transaction_id);
assert.deepEqual(outputs[3].result.record.record.commit_id, expected.commit_id);
assert.deepEqual(outputs[3].result.projection.cursor, expected.cursor);
assert.equal(outputs[3].result.projection.last_boundary, expected.last_boundary);
assert.equal(outputs[4].result.transaction_id, expected.transaction_id);
assert.deepEqual(outputs[3].result.context_plan, expected.context_plan);
assert.deepEqual(outputs[4].result.context_plan, expected.context_plan);
assert.deepEqual(outputs[4].result.projection, outputs[3].result.projection);

console.log("native/WASM golden trace: ok");
