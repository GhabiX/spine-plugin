import { pathToFileURL } from "node:url";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

const dist = process.env.SPINE_TEST_DIST
  ? pathToFileURL(`${process.env.SPINE_TEST_DIST}/pi/`)
  : new URL("../dist/pi/", import.meta.url);
const { createPiExtension } = await import(new URL("extension.js", dist));

// Real extension handlers + real Spine runtime; only the Pi event/UI shell is mocked.
export async function compactionFixture(t, { model, complete, reserveTokens = 16384 }) {
  const handlers = new Map(), entries = [], commands = [], notifications = [];
  let aborts = 0;
  const branch = [{ type: "message", id: "visible", parentId: null, timestamp: "1",
    message: { role: "user", content: "Preserve the continuation goal.", timestamp: 1 } }];
  const pi = {
    events: { on() {}, emit() {} }, registerFlag() {}, getFlag() { return false; },
    registerCommand() {}, registerTool() {}, getActiveTools() { return []; }, setActiveTools() {},
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  };
  const ctx = {
    cwd: "/tmp", mode: "print", hasUI: true, isIdle: () => true, model,
    modelRegistry: { complete }, abort() { aborts++; },
    ui: { setWidget() {}, notify(message, level) { notifications.push([message, level]); } },
    sessionManager: { getSessionId: () => "compaction-budget", getBranch: () => branch,
      getHeader: () => null, getSessionFile: () => undefined },
  };
  createPiExtension({ runtimeFactory: { create(thread) {
    const runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
    const execute = runtime.client.execute.bind(runtime.client);
    return { ...runtime, client: { async execute(command) { commands.push(command); return execute(command); } } };
  } } })(pi);
  async function emit(name, event = {}) {
    let result;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  }
  await emit("session_start", { type: "session_start", reason: "new" });
  t.after(() => emit("session_shutdown"));
  return {
    entries, commands, notifications, emit, get aborts() { return aborts; },
    async compact(signal = new AbortController().signal) {
      return emit("session_before_compact", {
        type: "session_before_compact", branchEntries: branch, signal, reason: "manual", willRetry: false,
        preparation: { firstKeptEntryId: "visible", tokensBefore: 12,
          messagesToSummarize: [], turnPrefixMessages: [],
          settings: { enabled: true, reserveTokens, keepRecentTokens: 20000 } },
      });
    },
  };
}

// Controlled protocol response, NOT a recorded paid-model response or a tokenizer.
// A synthetic workload needs 14000 reasoning + 64 answer tokens. Token accounting
// is declared fixture usage, not inferred from the short human-readable payload.
export function responsesFixtureFetch(requests, { alwaysNoText = false } = {}) {
  return async (url, init) => {
    if (String(url) !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected URL: ${url}`);
    const request = JSON.parse(init.body);
    requests.push(request);
    const cap = request.max_output_tokens;
    const hasText = !alwaysNoText && cap >= 14064;
    const reasoning = hasText ? 14000 : cap;
    const item = { id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Controlled reasoning, not the continuation answer." }] };
    const events = [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, summary: [] } },
      { type: "response.output_item.done", output_index: 0, item },
    ];
    const output = [item];
    if (hasText) {
      const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "## Goal\nContinue the task.", annotations: [] }] };
      output.push(message);
      events.push({ type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
        { type: "response.output_item.done", output_index: 1, item: message });
    }
    const status = hasText ? "completed" : "incomplete";
    events.push({ type: `response.${status}`, response: { id: "resp_fixture", status, output,
      incomplete_details: hasText ? null : { reason: "max_output_tokens" },
      usage: { input_tokens: 100, output_tokens: reasoning + (hasText ? 64 : 0),
        total_tokens: 100 + reasoning + (hasText ? 64 : 0),
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: reasoning } } } });
    const sse = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  };
}
