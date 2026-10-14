import assert from "node:assert/strict";
import test from "node:test";
import { createPiExtension } from "../dist/pi/extension.js";
import { SPINE_TREE_VIEW_REQUEST } from "../dist/pi/tree-view-contract.js";
import { queryPiSpineMode, SPINETREE_MODE_QUERY } from "../dist/pi/session-mode.js";

function fixture() {
  const handlers = new Map(), listeners = new Map(), tools = new Map(), entries = [], widgets = [];
  let id = "mode-test", active = [], aborts = 0;
  const pi = {
    events: {
      on(name, listener) { const list = listeners.get(name) ?? []; list.push(listener); listeners.set(name, list); },
      emit(name, data) { for (const listener of listeners.get(name) ?? []) listener(data); },
    },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerFlag() {}, getFlag() { return false; },
    registerTool(tool) {
      tools.set(tool.name, tool);
      active = active.filter(name => name !== tool.name);
      if ((tool.exposure ?? "direct") === "direct") active.push(tool.name);
    },
    getActiveTools() { return active; }, setActiveTools(names) { active = names; },
    appendEntry(type, data) { entries.push({type, data}); },
  };
  const ctx = {
    cwd: "/isolated/mode-test", mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => id, getBranch: () => [] },
    ui: { notify() { throw new Error("unexpected SDK notification"); }, setWidget(...args) { widgets.push(args); } },
    abort() { aborts++; },
  };
  return { pi, ctx, tools, entries, widgets, setId(value) { id = value; }, get aborts() { return aborts; },
    async emit(name, event = {}) { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; },
  };
}

for (const order of ["l1-first", "sdk-first"]) {
  test(`st mode hides all SDK tools and leaves context, compaction, tree and shutdown untouched (${order})`, async () => {
    const f = fixture();
    let ready = 0, response = "st", queries = 0;
    const respond = () => f.pi.events.on(SPINETREE_MODE_QUERY, query => {
      queries++;
      assert.equal(query.cwd, f.ctx.cwd);
      assert.equal(query.sessionId, "mode-test");
      query.mode = response;
    });
    if (order === "l1-first") respond();
    createPiExtension({ onSessionReady() { ready++; } })(f.pi);
    if (order === "sdk-first") respond();
    await f.emit("session_start");
    assert.equal(ready, 0);
    assert.deepEqual(f.pi.getActiveTools(), []);
    assert.equal(f.tools.size, 5);
    for (const tool of f.tools.values()) assert.equal(tool.exposure, "hidden");
    const options = { appendSystemPrompt: "unchanged" };
    const messages = [{ role: "user", content: "untouched", timestamp: 1 }];
    assert.deepEqual(await f.emit("context", {messages}), {});
    assert.equal(await f.emit("context_with_system", {messages}), undefined);
    assert.equal(await f.emit("session_before_compact"), undefined);
    for (const name of ["session_tree", "message_end", "before_provider_request", "tool_call", "tool_result", "turn_end", "session_compact"]) await f.emit(name);
    await f.emit("before_agent_start", {systemPromptOptions: options});
    assert.equal(options.appendSystemPrompt, "unchanged");
    let offers = 0;
    f.pi.events.emit(SPINE_TREE_VIEW_REQUEST, {version: 1, sessionId: "mode-test", accept() { offers++; }});
    assert.equal(offers, 0);
    const claim = {};
    f.pi.events.emit("pi:compaction-owner:v1", claim);
    assert.deepEqual(claim, {});
    assert.equal(f.entries.length, 0);
    assert.equal(f.widgets.length, 0);
    assert.equal(f.aborts, 0);
    response = "sdk";
    await f.emit("session_start"); // Same session never changes mode, even after discovery changes.
    assert.equal(queries, 1);
    assert.equal(ready, 0);
    await f.emit("session_shutdown");
    assert.equal(f.aborts, 0);
  });
}

for (const l1 of [false, true]) {
  test(`sdk mode retains normal tools, runtime, prompt and compaction ownership (${l1 ? "L1 without tree" : "no L1"})`, async () => {
    const f = fixture();
    if (l1) f.pi.events.on(SPINETREE_MODE_QUERY, query => { query.mode = "sdk"; });
    let ready = 0;
    createPiExtension({ onSessionReady() { ready++; } })(f.pi);
    await f.emit("session_start");
    assert.equal(ready, 1);
    assert.deepEqual(f.pi.getActiveTools().sort(), ["spine_close", "spine_next", "spine_open", "spine_spawn"]);
    const event = { systemPromptOptions: { appendSystemPrompt: "original" } };
    await f.emit("before_agent_start", event);
    assert.match(event.systemPromptOptions.appendSystemPrompt, /spine_open/);
    assert.match(event.systemPromptOptions.appendSystemPrompt, /original/);
    const claim = {};
    f.pi.events.emit("pi:compaction-owner:v1", claim);
    assert.equal(claim.owner, "@spinejit/pi-spinejit");
    assert.ok(f.widgets.length > 0);
    await f.emit("session_shutdown");
  });
}

test("SDK query has no local discovery fallback", () => {
  const f = fixture();
  assert.equal(queryPiSpineMode(f.pi, f.ctx), "sdk");
});
