import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import extension, {
  createPiExtension,
  createPiSpinePlugin,
  extractTypedChildMemory,
  SPINE_CANONICAL_PLUGIN_MANIFEST,
} from "../dist/pi/extension.js";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";
import { resolvePiInvocation } from "../dist/pi/invocation.js";
import { loadPiSpineConfigToml } from "../dist/pi/spine-config.js";
import { SPINE_TREE_VIEW_REQUEST } from "../dist/pi/tree-view-contract.js";

function mockPi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  const eventListeners = new Map();
  let childFlag = false;
  return {
    handlers,
    tools,
    commands,
    entries,
    sent,
    setChildFlag(value) {
      childFlag = value;
    },
    api: {
      events: {
        on(name, listener) {
          const listeners = eventListeners.get(name) ?? new Set();
          listeners.add(listener);
          eventListeners.set(name, listeners);
          return () => listeners.delete(listener);
        },
        emit(name, data) {
          for (const listener of eventListeners.get(name) ?? []) listener(data);
        },
      },
      registerFlag() {},
      getFlag(name) {
        return name === "spine-child" && childFlag;
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      getThinkingLevel() {
        return "low";
      },
      getActiveTools() {
        return this.activeTools ?? [
          "read",
          "bash",
          "edit",
          "write",
          "spine_open",
          "spine_close",
          "spine_next",
          "spine_spawn",
        ];
      },
      setActiveTools(names) {
        this.activeTools = [...names];
      },
      on(name, handler) {
        const existing = handlers.get(name) ?? [];
        existing.push(handler);
        handlers.set(name, existing);
      },
      appendEntry(customType, data) {
        entries.push({ customType, data });
      },
      sendMessage(message, options) {
        sent.push([message, options]);
      },
      async exec() {
        throw new Error("unexpected child execution");
      },
    },
    async emit(name, event, ctx) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event, ctx);
      }
      return result;
    },
  };
}

function extensionContext(sessionId = "pi-session", options = {}) {
  const notifications = [];
  const widgets = [];
  let aborts = 0;
  return {
    notifications,
    widgets,
    get aborts() {
      return aborts;
    },
    context: {
      mode: "tui",
      hasUI: true,
      isIdle: () => true,
      signal: undefined,
      cwd: "/tmp",
      model: { provider: "google", id: "gemini-3.8-flash" },
      thinkingLevel: "low",
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => options.branch ?? [],
        getSessionFile: () => options.sessionFile,
      },
      ui: {
        notify(message, level) {
          notifications.push([message, level]);
        },
        setWidget(key, content, options) {
          widgets.push([key, content, options]);
        },
        ...(options.select === undefined ? {} : { select: options.select }),
        ...(options.input === undefined ? {} : { input: options.input }),
      },
      abort() {
        aborts += 1;
      },
    },
  };
}

function gatedRuntimeFactory() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const runtimes = [];
  return {
    runtimes,
    release() {
      release();
    },
    create(thread) {
      const runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
      let disposed = false;
      const execute = runtime.client.execute.bind(runtime.client);
      const client = {
        async execute(command) {
          if (first) {
            first = false;
            await gate;
          }
          return execute(command);
        },
      };
      const wrapped = {
        client,
        extendSystemPrompt(base) {
          return runtime.extendSystemPrompt(base);
        },
        nodePrompt() {
          return runtime.nodePrompt();
        },
        toolCatalog() {
          return runtime.toolCatalog();
        },
        get disposed() {
          return disposed;
        },
        dispose() {
          disposed = true;
          runtime.dispose();
        },
      };
      runtimes.push(wrapped);
      return wrapped;
    },
  };
}

function widgetLines(widget, width = 80) {
  const content = widget[1];
  if (content === undefined) return [];
  if (Array.isArray(content)) return content;
  const theme = {
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
  return content({ terminal: { rows: 40 }, requestRender() {} }, theme).render(width);
}

function user(content) {
  return { role: "user", content, timestamp: 1 };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 7 },
    stopReason,
    timestamp: 2,
  };
}

// Pi ends every model request with turn_end. This is a synthetic boundary that only
// separates context projections: a real Pi cancel first emits message_end for the
// aborted assistant, which Spine observes as a source.
async function cancelTurn(pi, ctx) {
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistant([], "aborted"), toolResults: [] }, ctx.context);
}

test("durable context-only custom messages enter canonical context once and preserve replay order", async () => {
  const branch = [];
  const pi = mockPi();
  const ctx = extensionContext("persisted-custom", { branch });
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const custom = { type: "custom_message", id: "custom-1", customType: "ordinary-resource",
    content: "version one", display: false, timestamp: "2026-09-26T00:00:00.000Z" };
  branch.push(custom); // Pi's context-only flush does not call extension message_end.
  const first = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  await cancelTurn(pi, ctx);
  const second = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  await cancelTurn(pi, ctx);
  assert.deepEqual(first, second);
  assert.equal(first.messages.filter(message => message.customType === "ordinary-resource").length, 1);
  branch.push({ ...custom, id: "custom-2", content: "version two" });
  const next = user("feedback");
  await pi.emit("message_end", { type: "message_end", message: next }, ctx.context);
  branch.push({ type: "message", id: "user-1", message: next });
  const live = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(live.messages.map(message => message.content), ["version one", "version two", "[U1]\nfeedback"]);
  const recovered = mockPi();
  createPiExtension()(recovered.api);
  await recovered.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  assert.deepEqual(await recovered.emit("context", { type: "context", messages: [] }, ctx.context), live);
  assert.equal(ctx.aborts, 0);
});

test("custom steering after a silent durable message preserves sources and committed replay", async (t) => {
  const branch = [];
  const pi = mockPi();
  const ctx = extensionContext("silent-then-custom", { branch });
  const append = pi.api.appendEntry.bind(pi.api);
  pi.api.appendEntry = (customType, data) => {
    append(customType, data);
    branch.push({ type: "custom", id: `archive-${pi.entries.length}`, customType, data });
  };
  let liveRuntime;
  let commit;
  createPiExtension({
    onSessionReady(info) { liveRuntime = info.runtime; },
    onSamplingCommit(info) { commit = info.commit; },
  })(pi.api);
  t.after(() => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx.context));
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);

  const silent = { type: "custom_message", id: "silent", customType: "resource-update",
    content: "silent A", display: false, timestamp: "2026-09-26T00:00:00.000Z" };
  // Pi flushes context-only A after turn_end without an extension message event.
  branch.push(silent);
  const queued = { role: "custom", customType: "resource-update", content: "queued B",
    display: false, timestamp: 2 };
  // Both custom steer and followUp queues deliver this event before persistence
  // and before the next context hook in Pi 0.87.1.
  await pi.emit("message_end", { type: "message_end", message: queued }, ctx.context);
  branch.push({ ...silent, id: "queued", content: queued.content });
  const projected = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const admitted = (await liveRuntime.client.execute({ type: "source_snapshot" })).source;
  await t.test("canonical source characters agree with the displayed entry order", () => {
    assert.deepEqual(admitted.cells.map(cell => cell.item.Message.message.content), ["silent A", "queued B"]);
    assert.deepEqual(projected.messages.map(message => message.content), ["silent A", "queued B"]);
  });

  const done = assistant([{ type: "text", text: "acknowledged both updates" }]);
  await pi.emit("message_end", { type: "message_end", message: done }, ctx.context);
  branch.push({ type: "message", id: "done", message: done });
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: done }, ctx.context);
  assert.equal(ctx.aborts, 0);
  assert.equal(commit.type, "committed");
  assert.deepEqual(pi.entries.filter(entry => entry.customType === "spine.archive.v1")
    .map(entry => entry.data.record.type), ["sampling_started", "sampling_commit"]);
  const committedSource = (await liveRuntime.client.execute({ type: "source_snapshot" })).source;
  const live = await pi.emit("context", { type: "context", messages: [] }, ctx.context);

  await t.test("the persisted sampling receipt replays the same sources and projection", async () => {
    const recovered = mockPi();
    const recoveredCtx = extensionContext("silent-then-custom", { branch });
    let recoveredRuntime;
    createPiExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
    t.after(() => recovered.emit("session_shutdown", { type: "session_shutdown" }, recoveredCtx.context));
    await recovered.emit("session_start", { type: "session_start", reason: "resume" }, recoveredCtx.context);
    assert.equal(recoveredCtx.aborts, 0, JSON.stringify(recoveredCtx.notifications));
    assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, committedSource);
    const replayed = await recovered.emit("context", { type: "context", messages: [] }, recoveredCtx.context);
    // Pi persists custom entries with its own timestamp; compare message meaning,
    // while the source snapshot above checks exact canonical identities/content.
    const projectedMeaning = ({ messages }) => messages.map(({ role, customType, content, display }) =>
      ({ role, customType, content, display }));
    assert.deepEqual(projectedMeaning(replayed), projectedMeaning(live));
  });
});

test("default export is a loadable Pi extension with the canonical tools", () => {
  const pi = mockPi();
  extension(pi.api);
  assert.deepEqual(
    [...pi.tools.keys()].sort(),
    ["spine_close", "spine_next", "spine_open", "spine_spawn"],
  );
  for (const name of ["spine_open", "spine_close", "spine_next"]) {
    const tool = pi.tools.get(name);
    assert.equal(tool.renderShell, "self");
    assert.deepEqual(tool.renderCall({}, {}, {}).render(80), []);
    assert.deepEqual(
      tool.renderResult(
        { content: [{ type: "text", text: `Spine ${name} staged` }], details: { staged: true } },
        { expanded: false, isPartial: false },
        { fg(_c, t) { return t; }, bold(t) { return t; } },
        { isError: false },
      ).render(80),
      [],
    );
  }
  assert.equal(typeof pi.tools.get("spine_spawn").renderCall, "function");
  assert.deepEqual([...pi.commands.keys()], []);
  assert.ok(pi.handlers.has("context"));
  assert.ok(pi.handlers.has("before_agent_start"));
  assert.ok(pi.handlers.has("session_before_compact"));
});

test("canonical Pi extension is also a SpineHost owner plugin", async () => {
  const pi = mockPi();
  const plugin = createPiSpinePlugin({ pi: pi.api });

  assert.deepEqual(plugin.manifest, SPINE_CANONICAL_PLUGIN_MANIFEST);
  await plugin.activate({});
  assert.deepEqual(
    [...pi.tools.keys()].sort(),
    ["spine_close", "spine_next", "spine_open", "spine_spawn"],
  );
  assert.ok(pi.handlers.has("context"));
  assert.ok(pi.handlers.has("turn_end"));
});

test("before_agent_start composes the configured prompt and registers its tool catalog", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);

  const event = {
    type: "before_agent_start",
    prompt: "Implement the task",
    systemPrompt: "base system prompt",
    systemPromptOptions: { appendSystemPrompt: "host append instructions" },
  };
  await pi.emit("before_agent_start", event, ctx.context);

  const expectedRuntime = createNodeSpineRuntime({
    thread: "pi-session",
    features: ["jit", "spawn"],
    configToml: loadPiSpineConfigToml(),
  });
  try {
    assert.equal(
      event.systemPromptOptions.appendSystemPrompt,
      expectedRuntime.extendSystemPrompt("host append instructions"),
    );
    assert.deepEqual(
      [...pi.tools.values()].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: JSON.parse(JSON.stringify(parameters)),
      })),
      expectedRuntime.toolCatalog().map(({ id, description, parameters }) => ({
        name: `spine_${id}`,
        description,
        parameters,
      })),
    );
  } finally {
    expectedRuntime.dispose();
  }
});

test("context_with_system preserves host messages and restores Spine node roles per request", async () => {
  const pi = mockPi();
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, extensionContext().context);
  const messages = [
    { role: "system", content: "Pi host instructions", timestamp: 1 },
    {
      role: "custom",
      customType: "spine.node",
      content: '<spine_node id="0" status="opened">node instructions</spine_node>',
      display: false,
      timestamp: 2,
      details: {
        schema: "spine.pi.projection/v1",
        kind: "node",
        nodeId: "0",
        renderer: "xml",
      },
    },
    {
      role: "custom",
      customType: "spine.memory",
      content: "<spine_memory>returned context</spine_memory>",
      display: false,
      timestamp: 3,
      details: {
        schema: "spine.pi.projection/v1",
        kind: "memory",
        nodeId: "0",
        renderer: "xml",
      },
    },
    { role: "user", content: "continue", timestamp: 4 },
  ];

  const projected = await pi.emit(
    "context_with_system",
    { messages },
    extensionContext().context,
  );

  assert.deepEqual(projected.messages.map((message) => message.role), [
    "system",
    "system",
    "custom",
    "user",
  ]);
  assert.equal(projected.messages[0].content, "Pi host instructions");
  assert.equal(projected.messages[1].content, messages[1].content);
  assert.equal(projected.messages[2].customType, "spine.memory");
  assert.equal(projected.messages[3].content, "continue");
  assert.equal(messages[1].role, "custom");
});

test("child mode keeps ordinary tools, Spine tree tools, nested spawn, and typed return", async () => {
  const pi = mockPi();
  createPiExtension()(pi.api);
  assert.equal(pi.tools.has("spine_child_return"), false);
  pi.setChildFlag(true);
  await pi.emit(
    "session_start",
    { type: "session_start", reason: "new" },
    extensionContext().context,
  );
  assert.equal(pi.tools.has("spine_child_return"), true);
  assert.deepEqual(pi.api.activeTools, [
    "read",
    "bash",
    "edit",
    "write",
    "spine_open",
    "spine_close",
    "spine_next",
    "spine_spawn",
    "spine_child_return",
  ]);
});

test("child mode installs Spine lifecycle so descendant open/close/next can run", async () => {
  const pi = mockPi();
  pi.setChildFlag(true);
  createPiExtension()(pi.api);
  const ctx = extensionContext();
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const event = {
    type: "before_agent_start",
    prompt: "child work",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", event, ctx.context);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /spine_open/);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /spine_close/);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /spine_next/);
});

test("session transitions never install a stale asynchronous runtime", async () => {
  const pi = mockPi();
  const factory = gatedRuntimeFactory();
  const firstCtx = extensionContext("first-session");
  const secondCtx = extensionContext("second-session");
  createPiExtension({ runtimeFactory: factory })(pi.api);

  const first = pi.emit(
    "session_start",
    { type: "session_start", reason: "new" },
    firstCtx.context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = pi.emit(
    "session_tree",
    { type: "session_tree" },
    secondCtx.context,
  );
  await second;
  factory.release();
  await first;

  assert.equal(factory.runtimes.length, 2);
  assert.equal(factory.runtimes[0].disposed, true);
  assert.equal(factory.runtimes[1].disposed, false);
  await pi.emit("message_end", { type: "message_end", message: user("current") }, secondCtx.context);
  const current = await pi.emit("context", { type: "context", messages: [] }, secondCtx.context);
  assert.deepEqual(current.messages, [user("[U1]\ncurrent")]);
});

test("session_tree resets a prior lifecycle fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "open-1",
      toolName: "spine_open",
      input: { goal: "inspect" },
    },
    ctx.context,
  );
  assert.equal(ctx.aborts, 1);

  await pi.emit("session_tree", { type: "session_tree" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("recovered") }, ctx.context);
  const recovered = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(recovered.messages, [user("[U1]\nrecovered")]);
});

async function finishHeadlessSampling(pi, ctx) {
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("private task content") }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const done = assistant([{ type: "text", text: "done" }]);
  await pi.emit("message_end", { type: "message_end", message: done }, ctx.context);
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: done }, ctx.context);
}

test("headless post-commit fault is recorded once before abort with its typed cause", async () => {
  const pi = mockPi();
  const ctx = extensionContext("headless-fault");
  ctx.context.hasUI = false;
  const order = [];
  const append = pi.api.appendEntry.bind(pi.api);
  pi.api.appendEntry = (type, data) => {
    append(type, data);
    if (type === "spine.fault.v1") order.push("fault");
  };
  const abort = ctx.context.abort;
  ctx.context.abort = () => {
    order.push("abort");
    abort();
  };
  const conflict = Object.assign(new Error("Cannot replace a live mapping"), {
    name: "SpineTreeScopeError",
    code: "binding-conflict",
    payload: "private error payload",
  });
  createPiExtension({
    onSamplingCommit() {
      throw new Error("ProjectTree import failed", { cause: conflict });
    },
  })(pi.api);

  await finishHeadlessSampling(pi, ctx);
  assert.deepEqual(order, ["fault", "abort"]);
  const faults = () => pi.entries.filter((entry) => entry.customType === "spine.fault.v1");
  assert.equal(faults().length, 1);
  const diagnostic = faults()[0].data;
  assert.equal(diagnostic.schema, "spine.fault/v1");
  assert.equal(diagnostic.hook, "turn_end");
  assert.equal(diagnostic.stage, "sampling_commit_observer");
  assert.equal(diagnostic.sessionId, "headless-fault");
  assert.ok(diagnostic.transactionId.startsWith("headless-fault-commit-"));
  assert.deepEqual(diagnostic.cursor, [1]);
  assert.ok(Number.isInteger(diagnostic.lastBoundary));
  assert.ok(Number.isFinite(diagnostic.timestamp));
  assert.deepEqual(diagnostic.errors, [
    { name: "Error", message: "ProjectTree import failed" },
    { name: "SpineTreeScopeError", code: "binding-conflict", message: "Cannot replace a live mapping" },
  ]);
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
  assert.equal(JSON.stringify(diagnostic).includes("stack"), false);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.equal(faults().length, 1);
  assert.deepEqual(order, ["fault", "abort", "abort"]);
  assert.deepEqual(ctx.notifications, []);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx.context);
});

test("headless successful post-commit hook produces no fault diagnostic", async () => {
  const pi = mockPi();
  const ctx = extensionContext("headless-success");
  ctx.context.hasUI = false;
  let commits = 0;
  createPiExtension({ onSamplingCommit() { commits += 1; } })(pi.api);
  await finishHeadlessSampling(pi, ctx);
  assert.equal(commits, 1);
  assert.equal(ctx.aborts, 0);
  assert.deepEqual(pi.entries.filter((entry) => entry.customType === "spine.fault.v1"), []);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx.context);
});

test("headless fault persistence failure preserves original fault and abort", async (t) => {
  const pi = mockPi();
  const ctx = extensionContext("headless-store-failure");
  ctx.context.hasUI = false;
  const errors = [];
  t.mock.method(console, "error", (text) => errors.push(JSON.parse(text)));
  const append = pi.api.appendEntry.bind(pi.api);
  let attempts = 0;
  pi.api.appendEntry = (type, data) => {
    if (type === "spine.fault.v1") {
      attempts += 1;
      throw Object.assign(new Error("Session append failed"), { code: "EIO" });
    }
    append(type, data);
  };
  createPiExtension({
    onSamplingCommit() {
      throw Object.assign(new Error("Original binding failure"), { code: "binding-conflict" });
    },
  })(pi.api);
  await finishHeadlessSampling(pi, ctx);
  assert.equal(ctx.aborts, 1);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errors[0].code, "binding-conflict");
  assert.equal(errors[0].persistenceErrors[0].code, "EIO");
  const admission = await pi.emit("tool_call", {
    type: "tool_call", toolCallId: "after-fault", toolName: "spine_open", input: { goal: "continue" },
  }, ctx.context);
  assert.deepEqual(admission, { block: true, reason: "Spine durability is faulted: Original binding failure" });
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.equal(attempts, 1);
  assert.equal(ctx.aborts, 2);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx.context);
});

test("user abort of a host tool does not latch a fault on a stray follow-up turn_end", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const commits = [];
  createPiExtension({
    onSamplingCommit(info) {
      commits.push(info.commit);
    },
  })(pi.api);

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("investigate") }, ctx.context);
  const firstPrompt = {
    type: "before_agent_start",
    prompt: "investigate",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", firstPrompt, ctx.context);
  assert.match(firstPrompt.systemPromptOptions.appendSystemPrompt, /spine_open/);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);

  const callMessage = assistant(
    [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "find /data /home" } }],
    "toolUse",
  );
  await pi.emit("message_end", { type: "message_end", message: callMessage }, ctx.context);
  await pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "find /data /home" },
    },
    ctx.context,
  );

  const aborted = new AbortController();
  aborted.abort();
  ctx.context.signal = aborted.signal;
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "find /data /home" },
      content: [{ type: "text", text: "Command aborted" }],
      details: {},
      isError: true,
    },
    ctx.context,
  );
  await pi.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: callMessage, toolResults: [] },
    ctx.context,
  );
  await pi.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 1, message: assistant([], "error") },
    ctx.context,
  );

  assert.equal(ctx.aborts, 0);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].type, "committed");
  assert.equal(commits[0].record.type, "sampling_commit");
  assert.equal(
    pi.entries.filter((entry) => entry.customType === "spine.archive.v1").length,
    2,
  );

  ctx.context.signal = new AbortController().signal;
  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const done = assistant([{ type: "text", text: "ok" }], "stop");
  await pi.emit("message_end", { type: "message_end", message: done }, ctx.context);
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 2, message: done }, ctx.context);

  assert.equal(ctx.aborts, 0);
  assert.equal(commits.length, 2);
  assert.equal(
    pi.entries.filter((entry) => entry.customType === "spine.archive.v1").length,
    4,
  );
});

test("Pi cache-warming replays are not samplings, during a tool call or after the run settles", async () => {
  // Pi's CacheWarmer re-sends the last request with maxTokens: 1 and the same
  // onPayload, so before_provider_request fires without a context hook: while
  // a long tool call runs ("streaming") and after turn_end ("idle").
  const pi = mockPi();
  const ctx = extensionContext("cache-warm");
  const commits = [];
  createPiExtension({ onSamplingCommit(info) { commits.push(info.commit); } })(pi.api);
  const warm = () => pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "test", max_tokens: 1 } },
    ctx.context,
  );
  const request = async () => {
    await pi.emit("context", { type: "context", messages: [] }, ctx.context);
    await pi.emit("before_provider_request", { type: "before_provider_request", payload: { model: "test" } }, ctx.context);
  };

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("sleep 300") }, ctx.context);
  await request();
  const callMessage = assistant(
    [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 300" } }],
    "toolUse",
  );
  await pi.emit("message_end", { type: "message_end", message: callMessage }, ctx.context);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: "sleep 300" } }, ctx.context);
  await warm();
  assert.equal(ctx.aborts, 0, JSON.stringify(ctx.notifications));
  const toolResult = {
    role: "toolResult",
    toolCallId: "bash-1",
    toolName: "bash",
    content: [{ type: "text", text: "" }],
    isError: false,
    timestamp: 3,
  };
  await pi.emit("tool_result", { type: "tool_result", toolCallId: "bash-1", toolName: "bash",
    input: { command: "sleep 300" }, content: toolResult.content, details: {}, isError: false }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: toolResult }, ctx.context);
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: callMessage, toolResults: [toolResult] }, ctx.context);
  await warm();

  await request();
  const done = assistant([{ type: "text", text: "slept" }]);
  await pi.emit("message_end", { type: "message_end", message: done }, ctx.context);
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 1, message: done, toolResults: [] }, ctx.context);

  assert.equal(ctx.aborts, 0, JSON.stringify(ctx.notifications));
  assert.deepEqual(pi.entries.filter(entry => entry.customType === "spine.fault.v1"), []);
  assert.deepEqual(commits.map(commit => commit.type), ["committed", "committed"]);
  assert.deepEqual(pi.entries.filter(entry => entry.customType === "spine.archive.v1")
    .map(entry => entry.data.record.type), ["sampling_started", "sampling_commit", "sampling_started", "sampling_commit"]);
});

test("a model request while the prior sampling is still open faults", async () => {
  const pi = mockPi();
  const ctx = extensionContext("missed-turn-end");
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("first") }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.equal(ctx.aborts, 0);
  assert.deepEqual(await pi.emit("context", { type: "context", messages: [] }, ctx.context), { messages: [] });
  assert.equal(ctx.aborts, 1);
  const faults = pi.entries.filter(entry => entry.customType === "spine.fault.v1");
  assert.equal(faults.length, 1);
  assert.equal(faults[0].data.hook, "context");
  assert.match(faults[0].data.errors.at(-1).message, /before the prior turn ended/);
});

function childReturn(memory) {
  return {
    stdout: JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "spine_child_return", arguments: { memory } }],
      },
    }),
    stderr: "",
    code: 0,
    killed: false,
  };
}

async function until(condition) {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 200) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Records what Pi would persist, in order, so a second extension can replay it. */
function recordBranch(pi) {
  const branch = [];
  const emit = pi.emit.bind(pi);
  // Pi emits message_end before it persists the message.
  pi.emit = async (name, event, ctx) => {
    const result = await emit(name, event, ctx);
    if (name === "message_end") {
      const message = structuredClone(event.message);
      branch.push(message.role === "custom"
        ? { type: "custom_message", id: `e${branch.length}`, customType: message.customType, content: message.content, display: message.display, details: message.details }
        : { type: "message", id: `e${branch.length}`, message });
    }
    return result;
  };
  const appendEntry = pi.api.appendEntry;
  pi.api.appendEntry = (customType, data) => {
    branch.push({ type: "custom", id: `e${branch.length}`, customType, data: structuredClone(data) });
    appendEntry(customType, data);
  };
  return branch;
}

/** One model request: the assistant message, its tool calls with their results, then turn_end. */
async function sample(pi, ctx, calls, text) {
  const context = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const message = assistant([
    ...(text === undefined ? [] : [{ type: "text", text }]),
    ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.input })),
  ], calls.length === 0 ? "stop" : "toolUse");
  await pi.emit("message_end", { type: "message_end", message }, ctx.context);
  const admissions = [];
  for (const call of calls) {
    const admission = await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: call.id, toolName: call.name, input: call.input },
      ctx.context,
    );
    admissions.push(admission);
    const result = admission?.block
      ? { content: [{ type: "text", text: admission.reason }], details: {}, isError: true }
      : { ...(await pi.tools.get(call.name).execute(call.id, call.input, undefined, undefined, ctx.context)), isError: false };
    await pi.emit("tool_result", { type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.input, ...result }, ctx.context);
    await pi.emit("message_end", {
      type: "message_end",
      message: { role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, timestamp: 3 },
    }, ctx.context);
  }
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] }, ctx.context);
  return { context: context.messages, admissions };
}

function contents(messages) {
  return messages.map((message) => typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? `[${part.type}]`).join(""));
}

const SPAWN_TASKS = [{ summary: "alpha", prompt: "do alpha work" }, { summary: "beta", prompt: "do beta work" }];

test("Spawn returns at once; children start after the commit and each arrives on its own", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-spine-spawn-live-"));
  const pi = mockPi();
  const ctx = extensionContext("pi-live", {
    sessionFile: join(dir, "parent.jsonl"),
    branch: [{
      type: "message",
      id: "aaaaaaaa",
      parentId: null,
      timestamp: "2026-09-17T12:00:00.000Z",
      message: { role: "user", content: "parent prefix TOKEN", timestamp: 1 },
    }],
  });
  const invocations = [];
  pi.api.exec = async (command, args) => {
    invocations.push({ command, args });
    return childReturn(args.at(-1).includes("You are: alpha") ? "alpha memory" : "beta memory");
  };
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await sample(pi, ctx, [{ id: "open-1", name: "spine_open", input: { goal: "work" } }]);

  // The tool only acknowledges; nothing runs until turn_end commits the births.
  const spawn = { id: "spawn-1", name: "spine_spawn", input: { tasks: SPAWN_TASKS } };
  const spawnCall = assistant([{ type: "toolCall", id: spawn.id, name: spawn.name, arguments: spawn.input }], "toolUse");
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: spawnCall }, ctx.context);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: spawn.id, toolName: spawn.name, input: spawn.input }, ctx.context);
  const accepted = await pi.tools.get("spine_spawn").execute(spawn.id, spawn.input, undefined, undefined, ctx.context);
  assert.match(accepted.content[0].text, /accepted 2 tasks/);
  assert.equal(invocations.length, 0);
  await pi.emit("tool_result", { type: "tool_result", toolCallId: spawn.id, toolName: spawn.name, input: spawn.input, ...accepted, isError: false }, ctx.context);
  await pi.emit("message_end", {
    type: "message_end",
    message: { role: "toolResult", toolCallId: spawn.id, toolName: spawn.name, ...accepted, isError: false, timestamp: 3 },
  }, ctx.context);
  await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: spawnCall, toolResults: [] }, ctx.context);
  await until(() => pi.sent.length === 2);

  const invocation = resolvePiInvocation({ execPath: process.execPath, execArgv: process.execArgv, argv: process.argv });
  const alpha = invocations.find(({ args }) => args.at(-1).includes("You are: alpha"));
  assert.equal(alpha.command, invocation.command);
  assert.ok(alpha.args.includes("--spine-child=true"));
  assert.ok(alpha.args.includes(`--spine-parent-pid=${process.pid}`));
  assert.match(alpha.args.at(-1), /^- beta$/m);
  const sessionPath = alpha.args[alpha.args.indexOf("--session") + 1];
  assert.equal(sessionPath, join(dir, "spine-spawn", "pi-live", "1.1.1.jsonl"));
  assert.match(await readFile(sessionPath, "utf8"), /parent prefix TOKEN/);

  const arrivals = pi.sent.map(([message]) => message.details.arrival).sort((a, b) => a.producer.join(".").localeCompare(b.producer.join(".")));
  assert.deepEqual(arrivals.map(({ producer, outcome, memory }) => [producer.join("."), outcome, memory]), [
    ["1.1.1", "completed", "alpha memory"],
    ["1.1.2", "completed", "beta memory"],
  ]);
  assert.deepEqual(pi.sent.map(([, options]) => options), [
    { deliverAs: "steer", triggerTurn: true },
    { deliverAs: "steer", triggerTurn: true },
  ]);

  // Close waits for every birth in its scope.
  const early = await sample(pi, ctx, [{ id: "close-early", name: "spine_close", input: { memory: "too soon" } }], "narration inside the node");
  assert.equal(early.admissions[0].block, true);
  assert.match(early.admissions[0].reason, /1\.1\.1 \(alpha\), 1\.1\.2 \(beta\) have not arrived/);

  await pi.emit("message_end", { type: "message_end", message: pi.sent[0][0] }, ctx.context);
  const partial = await sample(pi, ctx, [{ id: "close-partial", name: "spine_close", input: { memory: "still early" } }]);
  assert.equal(partial.admissions[0].block, true);
  await pi.emit("message_end", { type: "message_end", message: pi.sent[1][0] }, ctx.context);

  await sample(pi, ctx, [], "interim answer for the user");
  await sample(pi, ctx, [{ id: "close-1", name: "spine_close", input: { memory: "node memory" } }]);
  assert.equal(ctx.aborts, 0);
  const after = contents((await pi.emit("context", { type: "context", messages: [] }, ctx.context)).messages);
  const once = (pattern) => after.filter((text) => pattern.test(text)).length;
  assert.equal(once(/<spine_spawn node_id="1\.1\.1" summary="alpha">/), 1);
  assert.equal(once(/<spine_arrival node_id="1\.1\.1" outcome="completed">\nalpha memory/), 1);
  assert.equal(once(/<spine_arrival node_id="1\.1\.2" outcome="completed">\nbeta memory/), 1);
  assert.equal(once(/^interim answer for the user$/), 1);
  assert.equal(once(/narration inside the node/), 0);
  assert.equal(once(/<spine_memory node_id="1\.1">\nnode memory/), 1);
  const order = ["<spine_spawn node_id=\"1.1.1\"", "<spine_arrival node_id=\"1.1.1\"", "interim answer", "<spine_memory node_id=\"1.1\""]
    .map((marker) => after.findIndex((text) => text.includes(marker)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("after a restart a returned child is redelivered without running, an unreturned one is abandoned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-spine-spawn-restart-"));
  const sessionFile = join(dir, "parent.jsonl");
  const pi = mockPi();
  const branch = recordBranch(pi);
  const ctx = extensionContext("pi-restart", { sessionFile });
  ctx.context.sessionManager.getBranch = () => branch;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started = 0;
  pi.api.exec = async () => {
    started += 1;
    return held;
  };
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await sample(pi, ctx, [{ id: "spawn-1", name: "spine_spawn", input: { tasks: SPAWN_TASKS } }]);
  await until(() => started === 2);
  // The parent dies before either arrival is admitted; alpha had written its return.
  const alphaSession = SessionManager.open(join(dir, "spine-spawn", "pi-restart", "1.1.jsonl"), undefined, "/tmp");
  alphaSession.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "r", name: "spine_child_return", arguments: { memory: "alpha memory" } }],
    api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 5,
  });
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
  release(childReturn("too late"));

  const restarted = mockPi();
  restarted.api.exec = async () => {
    throw new Error("recovery must not rerun a child");
  };
  const headless = extensionContext("pi-restart", { sessionFile, branch });
  headless.context.hasUI = false;
  createPiExtension()(restarted.api);
  await restarted.emit("session_start", { type: "session_start", reason: "resume" }, headless.context);
  await until(() => restarted.sent.length === 2);
  const byProducer = Object.fromEntries(restarted.sent.map(([message, options]) => [message.details.arrival.producer.join("."), [message.details.arrival, options]]));
  assert.deepEqual(byProducer["1.1"], [{ producer: [1, 1], outcome: "completed", memory: "alpha memory" }, { deliverAs: "steer", triggerTurn: false }]);
  assert.equal(byProducer["1.2"][0].outcome, "aborted");
  assert.match(byProducer["1.2"][0].diagnostic, /restarted before this child returned/);
  assert.equal(pi.sent.length, 0);
  assert.equal(headless.aborts, 0);
});

test("Stop cancels running children; their aborted arrivals do not wake the agent", async () => {
  const pi = mockPi();
  const ctx = extensionContext("pi-stop", { sessionFile: join(await mkdtemp(join(tmpdir(), "pi-spine-stop-")), "parent.jsonl") });
  // Like pi.exec, an already-aborted signal kills at once.
  pi.api.exec = (_command, _args, options) => new Promise((resolve) => {
    const killed = () => resolve({ stdout: "", stderr: "terminated", code: 143, killed: true });
    if (options.signal.aborted) killed();
    else options.signal.addEventListener("abort", killed, { once: true });
  });
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await sample(pi, ctx, [{ id: "spawn-1", name: "spine_spawn", input: { tasks: SPAWN_TASKS } }]);
  assert.equal(pi.sent.length, 0);
  await pi.emit("agent_settled", { type: "agent_settled", aborted: true }, ctx.context);
  await until(() => pi.sent.length === 2);
  for (const [message, options] of pi.sent) {
    assert.equal(message.details.arrival.outcome, "aborted");
    assert.deepEqual(options, { deliverAs: "steer", triggerTurn: false });
  }
});

test("without a UI the settled agent waits for a running child, whose arrival starts the next turn", async () => {
  const pi = mockPi();
  const ctx = extensionContext("pi-print", { sessionFile: join(await mkdtemp(join(tmpdir(), "pi-spine-print-")), "parent.jsonl") });
  ctx.context.hasUI = false;
  const gates = [];
  pi.api.exec = () => new Promise((resolve) => gates.push(resolve));
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await sample(pi, ctx, [{ id: "spawn-1", name: "spine_spawn", input: { tasks: SPAWN_TASKS } }]);
  await until(() => gates.length === 2);
  let settled = false;
  const waiting = pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx.context).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  gates[0](childReturn("first memory"));
  await waiting;
  assert.equal(pi.sent.length, 1);
  assert.deepEqual(pi.sent[0][1], { deliverAs: "steer", triggerTurn: true });
});

test("a child that cannot start arrives as errored without faulting the parent; compaction waits for it", async () => {
  const pi = mockPi();
  const ctx = extensionContext("pi-reject", { sessionFile: join(await mkdtemp(join(tmpdir(), "pi-spine-reject-")), "parent.jsonl") });
  pi.api.exec = async () => {
    throw new Error("host transport failure");
  };
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await sample(pi, ctx, [{ id: "spawn-1", name: "spine_spawn", input: { tasks: SPAWN_TASKS } }]);
  await until(() => pi.sent.length === 2);
  assert.deepEqual(pi.sent.map(([message]) => [message.details.arrival.outcome, message.details.arrival.diagnostic]), [
    ["errored", "host transport failure"],
    ["errored", "host transport failure"],
  ]);
  assert.equal(ctx.aborts, 0);

  const compact = await pi.emit("session_before_compact", { type: "session_before_compact" }, ctx.context);
  assert.deepEqual(compact, { cancel: true });
  assert.match(ctx.notifications.at(-1)[0], /compaction waits for spawned children 1\.1 \(alpha\), 1\.2 \(beta\)/);
});

test("root close and next return to the model without aborting", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const closeAdmission = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "close-1", toolName: "spine_close", input: { memory: "done" } },
    ctx.context,
  );
  const nextAdmission = await pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "next-1",
      toolName: "spine_next",
      input: { goal: "continue", memory: "done" },
    },
    ctx.context,
  );
  assert.deepEqual(closeAdmission, {
    block: true,
    reason: "no open Spine node is available to close",
  });
  assert.deepEqual(nextAdmission, {
    block: true,
    reason: "no open Spine node is available to close",
  });
  assert.equal(ctx.aborts, 0);

  const openAdmission = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "open-1", toolName: "spine_open", input: { goal: "inspect" } },
    ctx.context,
  );
  assert.equal(openAdmission, undefined);
  assert.equal(ctx.aborts, 0);
});

test("WASM-backed extension completes one Pi Open sampling transaction", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  const before = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(before.messages, [user("[U1]\nrequest")]);

  const callMessage = assistant([
    { type: "toolCall", id: "open-1", name: "spine_open", arguments: { goal: "inspect" } },
  ]);
  await pi.emit("message_end", { type: "message_end", message: callMessage }, ctx.context);
  await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "open-1", toolName: "spine_open", input: { goal: "inspect" } },
    ctx.context,
  );
  const openResult = await pi.tools.get("spine_open").execute(
    "open-1",
    { goal: "inspect" },
    undefined,
    undefined,
    ctx.context,
  );
  assert.equal(openResult.details.staged, true);
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "open-1",
      toolName: "spine_open",
      input: { goal: "inspect" },
      content: openResult.content,
      details: openResult.details,
      isError: false,
    },
    ctx.context,
  );
  const resultMessage = {
    role: "toolResult",
    toolCallId: "open-1",
    toolName: "spine_open",
    content: openResult.content,
    details: openResult.details,
    isError: false,
    timestamp: 3,
  };
  await pi.emit("message_end", { type: "message_end", message: resultMessage }, ctx.context);
  await pi.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: callMessage, toolResults: [resultMessage] },
    ctx.context,
  );

  const widget = ctx.widgets.at(-1);
  assert.equal(widget[0], "spine-tree");
  assert.deepEqual(widget[2], { placement: "aboveEditor" });
  const tree = widgetLines(widget).join("\n");
  assert.match(tree, /Spine Tree/);
  assert.match(tree, /◉/);
  assert.match(tree, /inspect/);
  assert.equal(tree.includes("1.1"), false);

  assert.deepEqual(pi.entries.map((entry) => entry.customType), [
    "spine.archive.v1",
    "spine.archive.v1",
  ]);
  assert.equal(pi.entries[0].data.record.type, "sampling_started");
  assert.equal(pi.entries[1].data.record.type, "sampling_commit");
  const after = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.match(after.messages[1].content, /<spine_node id="1\.1" summary="inspect" status="opened">/);
  assert.equal(ctx.aborts, 0);

  const compact = await pi.emit(
    "session_before_compact",
    { type: "session_before_compact" },
    ctx.context,
  );
  assert.deepEqual(compact, { cancel: true });
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
  assert.deepEqual(ctx.widgets.at(-1), ["spine-tree", undefined, undefined]);
});

test("WASM-backed extension blocks spawn mixed with open without aborting the session", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);

  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: user("request") }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const spawnInput = {
    tasks: [
      { summary: "child", prompt: "do child work" },
      { summary: "peer", prompt: "do peer work" },
    ],
  };
  const callMessage = assistant([
    { type: "toolCall", id: "open-1", name: "spine_open", arguments: { goal: "inspect" } },
    { type: "toolCall", id: "spawn-1", name: "spine_spawn", arguments: spawnInput },
  ], "toolUse");
  await pi.emit("message_end", { type: "message_end", message: callMessage }, ctx.context);

  const openAdmission = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "open-1", toolName: "spine_open", input: { goal: "inspect" } },
    ctx.context,
  );
  const spawnAdmission = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "spawn-1", toolName: "spine_spawn", input: spawnInput },
    ctx.context,
  );
  assert.equal(openAdmission, undefined);
  assert.deepEqual(spawnAdmission, {
    block: true,
    reason: "spine_spawn cannot be mixed with spine_open, spine_close, or spine_next",
  });
  assert.equal(ctx.aborts, 0);

  const openResult = await pi.tools.get("spine_open").execute(
    "open-1",
    { goal: "inspect" },
    undefined,
    undefined,
    ctx.context,
  );
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: "open-1",
      toolName: "spine_open",
      input: { goal: "inspect" },
      content: openResult.content,
      details: openResult.details,
      isError: false,
    },
    ctx.context,
  );
  const resultMessage = {
    role: "toolResult",
    toolCallId: "open-1",
    toolName: "spine_open",
    content: openResult.content,
    details: openResult.details,
    isError: false,
    timestamp: 3,
  };
  await pi.emit("message_end", { type: "message_end", message: resultMessage }, ctx.context);
  await pi.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: callMessage, toolResults: [resultMessage] },
    ctx.context,
  );

  assert.equal(ctx.aborts, 0);
  assert.equal(
    pi.entries.filter((entry) => entry.customType === "spine.archive.v1").at(-1).data.record.type,
    "sampling_commit",
  );

  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
  assert.equal(ctx.aborts, 0);
});

test("Pi overflow retry keeps an earlier error assistant after the null edit", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const earlierError = assistant([{ type: "text", text: "keep earlier" }], "error");
  const retryTarget = assistant([{ type: "text", text: "drop final" }], "length");
  const entries = [
    { type: "message", id: "earlier", parentId: null, timestamp: "1", message: earlierError },
    { type: "message", id: "final", parentId: "earlier", timestamp: "2", message: retryTarget },
    {
      type: "context_edit",
      id: "edit-final",
      parentId: "final",
      timestamp: "3",
      targetId: "final",
      replacement: null,
    },
  ];
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "retry summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => entries;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "earlier",
        messagesToSummarize: [earlierError, retryTarget],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: entries,
      signal: new AbortController().signal,
      reason: "overflow",
      willRetry: true,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "retry summary");
  const compact = pi.entries.find((entry) => entry.customType === "spine.compact.v1");
  assert.equal(compact.data.replacementMessages.length, 2);
  assert.deepEqual(compact.data.replacementMessages[1].content, [{ type: "text", text: "keep earlier" }]);
  assert.equal(JSON.stringify(compact.data.replacementMessages).includes("drop final"), false);
  assert.deepEqual(compact.data.replacementEntryIds, [null, "earlier"]);
});

test("Pi compaction summarizes the published model context plus one request", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const visible = user("model-visible-turn");
  const rawOnly = user("RAW-TRANSCRIPT-NOT-MODEL-CONTEXT");
  const entry = { type: "message", id: "visible", parentId: null, timestamp: "1", message: visible };
  let requestMessages;
  let requestOptions;
  ctx.context.model = { provider: "test", id: "test-model", maxTokens: 131072 };
  ctx.context.modelRegistry = {
    async complete(_model, context, options) {
      requestMessages = context.messages;
      requestOptions = options;
      return { content: [{ type: "text", text: "context summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "visible",
        messagesToSummarize: [rawOnly],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 52429, keepRecentTokens: 20000 },
        previousSummary: "earlier summary",
      },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "threshold",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "context summary");
  const rendered = JSON.stringify(requestMessages);
  assert.equal(rendered.includes("model-visible-turn"), true);
  assert.equal(rendered.includes("RAW-TRANSCRIPT-NOT-MODEL-CONTEXT"), false);
  assert.equal(rendered.includes("Conversation:"), false);
  assert.ok(requestMessages.length > 1);
  const instruction = requestMessages.at(-1);
  assert.equal(instruction.role, "user");
  assert.match(instruction.content[0].text, /^Create a concise structured continuation summary/);
  assert.match(instruction.content[0].text, /earlier summary/);
  assert.equal(requestOptions.maxTokens, 41943);
  assert.equal(requestMessages.some((message) => message.role === "system"), false);
  assert.equal(ctx.aborts, 0);
});

test("Pi compaction passes the current tool declarations with the model context", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const bash = { name: "bash", description: "run", parameters: { type: "object" } };
  const gone = { name: "old", description: "gone", parameters: { type: "object" } };
  const declared = {
    role: "system",
    content: "",
    toolsAdded: [bash, gone],
    timestamp: 1,
  };
  const removed = {
    role: "system",
    content: "",
    toolsRemoved: [{ name: "old" }],
    timestamp: 2,
  };
  const visible = user("model-visible-turn");
  const entries = [
    { type: "message", id: "tools", parentId: null, timestamp: "1", message: declared },
    { type: "message", id: "remove", parentId: "tools", timestamp: "2", message: removed },
    { type: "message", id: "visible", parentId: "remove", timestamp: "3", message: visible },
  ];
  let requestContext;
  ctx.context.model = { provider: "test", id: "test-model", maxTokens: 131072 };
  ctx.context.modelRegistry = {
    async complete(_model, context) {
      requestContext = context;
      return { content: [{ type: "text", text: "context summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => entries;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "visible",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 52429, keepRecentTokens: 20000 },
      },
      branchEntries: entries,
      signal: new AbortController().signal,
      reason: "threshold",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "context summary");
  assert.deepEqual(requestContext.tools, [bash]);
  assert.equal(JSON.stringify(requestContext.messages).includes("model-visible-turn"), true);
  assert.equal(requestContext.messages.some((message) => message.role === "system"), false);
  assert.equal(ctx.aborts, 0);
});

test("Pi compaction summary output cap follows the native reserve formula", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const visible = user("visible");
  const entry = { type: "message", id: "visible", parentId: null, timestamp: "1", message: visible };
  let requestOptions;
  ctx.context.model = { provider: "test", id: "test-model", maxTokens: 100 };
  ctx.context.modelRegistry = {
    async complete(_model, _context, options) {
      requestOptions = options;
      return { content: [{ type: "text", text: "capped summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "visible",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "threshold",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "capped summary");
  assert.equal(requestOptions.maxTokens, 100);
  assert.equal(ctx.aborts, 0);
});

test("Pi compaction previews the current model context before summarizing", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const arrived = user("just-arrived");
  const entry = { type: "message", id: "arrived", parentId: null, timestamp: "1", message: arrived };
  let requestMessages;
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete(_model, context) {
      requestMessages = context.messages;
      return { content: [{ type: "text", text: "fresh summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => [];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: arrived }, ctx.context);
  // Pi persists message_end before constructing the compaction snapshot.
  ctx.context.sessionManager.getBranch = () => [entry];
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "arrived",
        messagesToSummarize: [user("RAW-ONLY")],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "threshold",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "fresh summary");
  const rendered = JSON.stringify(requestMessages);
  assert.equal(rendered.includes("just-arrived"), true);
  assert.equal(rendered.includes("RAW-ONLY"), false);
  assert.equal(ctx.aborts, 0);
});

test("Pi context applies null and non-null context edits by entry id", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const kept = user("keep-user");
  const omitted = user("OMITTED");
  const entries = [];
  ctx.context.sessionManager.getBranch = () => entries;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);

  await pi.emit("message_end", { type: "message_end", message: kept }, ctx.context);
  entries.push({ type: "message", id: "keep", parentId: null, timestamp: "1", message: kept });
  await pi.emit("message_end", { type: "message_end", message: omitted }, ctx.context);
  entries.push({
    type: "message",
    id: "omit",
    parentId: "keep",
    timestamp: "2",
    message: omitted,
  });
  const original = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(original.messages, [{ ...kept, content: "[U1]\nkeep-user" }, { ...omitted, content: "[U2]\nOMITTED" }]);
  await cancelTurn(pi, ctx);
  const commitsBeforeEdits = structuredClone(pi.entries);
  entries.push({
    type: "context_edit",
    id: "edit-omit",
    parentId: "omit",
    timestamp: "3",
    targetId: "omit",
    replacement: null,
  });
  entries.push({
    type: "context_edit",
    id: "edit-keep",
    parentId: "edit-omit",
    timestamp: "4",
    targetId: "keep",
    replacement: { content: "rewritten-user" },
  });

  const context = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const text = JSON.stringify(context.messages);
  assert.equal(text.includes("OMITTED"), false);
  assert.equal(text.includes("keep-user"), false);
  assert.equal(text.includes("rewritten-user"), true);
  assert.deepEqual(context.messages, [{ ...kept, content: "[U1]\nrewritten-user" }]);
  // The second request only starts its sampling; the edits themselves record nothing.
  assert.deepEqual(pi.entries.slice(0, commitsBeforeEdits.length), commitsBeforeEdits);
  assert.deepEqual(pi.entries.slice(commitsBeforeEdits.length).map(entry => entry.data.record.type),
    ["sampling_started"], "host edits do not create commits");
  assert.equal(ctx.aborts, 0);
});

test("Pi compact tail uses the host projection for omissions and rewrites", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const omitted = assistant([{ type: "text", text: "OMITTED" }], "error");
  const kept = user("keep-user");
  const rewritten = user("old-text");
  const entries = [
    { type: "message", id: "omit", parentId: null, timestamp: "1", message: omitted },
    { type: "message", id: "keep", parentId: "omit", timestamp: "2", message: kept },
    {
      type: "context_edit",
      id: "edit-omit",
      parentId: "keep",
      timestamp: "3",
      targetId: "omit",
      replacement: null,
    },
    { type: "message", id: "rewrite", parentId: "edit-omit", timestamp: "4", message: rewritten },
    {
      type: "context_edit",
      id: "edit-text",
      parentId: "rewrite",
      timestamp: "5",
      targetId: "rewrite",
      replacement: { content: "new-text" },
    },
  ];
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "projected summary" }] };
    },
  };
  ctx.context.sessionManager.getBranch = () => entries;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "omit",
        messagesToSummarize: [omitted, kept, rewritten],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: entries,
      signal: new AbortController().signal,
      reason: "overflow",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "projected summary");
  const compact = pi.entries.find((entry) => entry.customType === "spine.compact.v1");
  const rendered = JSON.stringify(compact.data.replacementMessages);
  assert.equal(rendered.includes("OMITTED"), false);
  assert.equal(rendered.includes("old-text"), false);
  assert.equal(rendered.includes("keep-user"), true);
  assert.equal(rendered.includes("new-text"), true);
  assert.deepEqual(compact.data.replacementEntryIds, [null, "keep", "rewrite"]);
});

test("Pi compact abort after Spine completion faults the live session", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const kept = user("keep this recent request");
  const entry = { type: "message", id: "kept-1", parentId: null, timestamp: "1", message: kept };
  const signal = new AbortController();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() { return { content: [{ type: "text", text: "summary" }] }; },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: signal.signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  signal.abort();
  assert.equal(ctx.aborts, 1);
  await pi.emit("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: true, reason: "manual", willRetry: false }, ctx.context);
  assert.equal(ctx.aborts, 1);
});

test("Pi compact abort before Spine compact cancels without latching a fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const kept = user("keep this recent request");
  const entry = { type: "message", id: "kept-1", parentId: null, timestamp: "1", message: kept };
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "partial summary" }], stopReason: "aborted" };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(ctx.aborts, 0);
  assert.deepEqual(ctx.notifications, []);
  assert.equal(pi.entries.filter((item) => item.customType === "spine.compact.v1").length, 0);
  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
});

test("Pi compact summarization AbortError cancels without latching a fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const kept = user("keep this recent request");
  const entry = { type: "message", id: "kept-1", parentId: null, timestamp: "1", message: kept };
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(ctx.aborts, 0);
  assert.deepEqual(ctx.notifications, []);
  assert.equal(pi.entries.filter((item) => item.customType === "spine.compact.v1").length, 0);
  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
});

async function continueAfterSoftCancel(pi, ctx) {
  assert.equal(ctx.aborts, 0);
  assert.equal(pi.entries.filter((item) => item.customType === "spine.compact.v1").length, 0);
  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
}

function compactFixture() {
  const kept = user("keep this recent request");
  const entry = { type: "message", id: "kept-1", parentId: null, timestamp: "1", message: kept };
  return { kept, entry };
}

test("Pi compact model error notifies the provider reason and does not use the error body", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return {
        content: [{ type: "text", text: "## Goal\nDo not keep this error body." }],
        stopReason: "error",
        errorMessage: "provider overloaded",
      };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(ctx.notifications, [["provider overloaded", "error"]]);
  await continueAfterSoftCancel(pi, ctx);
});

test("Pi compact model error without errorMessage uses the stopReason fallback", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return {
        content: [{ type: "text", text: "looks like a summary" }],
        stopReason: "error",
        errorMessage: "   ",
      };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(ctx.notifications, [["Pi compaction model returned stopReason=error", "error"]]);
  await continueAfterSoftCancel(pi, ctx);
});

test("Pi compact empty summary cancels without latching a fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "   " }], stopReason: "stop" };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(ctx.notifications, [["Pi compaction model returned an empty summary", "error"]]);
  await continueAfterSoftCancel(pi, ctx);
});

test("Pi compact missing first-kept entry cancels without latching a fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "summary" }], stopReason: "stop" };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "missing", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(ctx.notifications, [["Pi compaction first-kept entry is missing from the active branch", "error"]]);
  await continueAfterSoftCancel(pi, ctx);
});

test("Pi compact complete failure cancels without latching a fault", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      throw new Error("summary model unavailable");
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(ctx.notifications, [["summary model unavailable", "error"]]);
  await continueAfterSoftCancel(pi, ctx);
});

test("Pi compact commit failure still faults the live session", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { kept, entry } = compactFixture();
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return { content: [{ type: "text", text: "summary" }], stopReason: "stop" };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "kept-1", messagesToSummarize: [kept], turnPrefixMessages: [], tokensBefore: 1, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(ctx.aborts, 1);
  assert.deepEqual(ctx.notifications, [["Spine faulted; current Pi operation aborted", "error"]]);
  await assert.rejects(
    () => pi.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue",
        systemPrompt: "base system prompt",
        systemPromptOptions: {},
      },
      ctx.context,
    ),
    /Pi Spine extension is faulted/,
  );
});

test("user abort after Spine tool register drains leftover execution without latching", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  await pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "open-1",
      toolName: "spine_open",
      input: { goal: "inspect" },
    },
    ctx.context,
  );
  assert.equal(ctx.aborts, 0);

  const aborted = new AbortController();
  aborted.abort();
  ctx.context.signal = aborted.signal;
  await pi.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: assistant([], "error") },
    ctx.context,
  );
  assert.equal(ctx.aborts, 0);

  ctx.context.signal = new AbortController().signal;
  const continued = {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  };
  await pi.emit("before_agent_start", continued, ctx.context);
  assert.match(continued.systemPromptOptions.appendSystemPrompt, /spine_open/);
});

test("Pi custom compaction summarizes, durably barriers, and publishes replacement context", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const kept = user("keep this recent request");
  const entry = {
    type: "message",
    id: "kept-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: kept,
  };
  ctx.context.model = { provider: "test", id: "test-model" };
  ctx.context.modelRegistry = {
    async complete() {
      return {
        content: [{ type: "text", text: "## Goal\nPreserve the active work." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      };
    },
  };
  ctx.context.sessionManager.getBranch = () => [entry];
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  await pi.emit("message_end", { type: "message_end", message: kept }, ctx.context);

  const result = await pi.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "kept-1",
        messagesToSummarize: [kept],
        turnPrefixMessages: [],
        tokensBefore: 12,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        previousSummary: undefined,
      },
      branchEntries: [entry],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "## Goal\nPreserve the active work.");
  assert.equal(pi.entries.filter((entry) => entry.customType === "spine.compact.v1").length, 1);

  await pi.emit(
    "session_compact",
    { type: "session_compact", compactionEntry: {}, fromExtension: true, reason: "manual", willRetry: false },
    ctx.context,
  );
  const context = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.equal(ctx.aborts, 0);
  assert.match(context.messages[0].summary, /Preserve the active work/);
  assert.deepEqual(context.messages[1], kept);
});

test("typed child-memory extraction rejects prose and duplicate returns", () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "spine_child_return",
          arguments: { memory: "bounded child memory" },
        },
      ],
    },
  });
  assert.equal(extractTypedChildMemory(`not-json\n${event}\n`), "bounded child memory");
  assert.throws(() => extractTypedChildMemory("plain final answer"), /0 typed terminal memories/);
  assert.throws(() => extractTypedChildMemory(`${event}\n${event}`), /2 typed terminal memories/);
});


test("optional browser connects synchronously and core invalidates it on session shutdown", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  createPiExtension()(pi.api);
  const connections = [];
  const request = { version: 1, sessionId: "pi-session", accept: value => connections.push(value) };
  pi.api.events.emit(SPINE_TREE_VIEW_REQUEST, request);
  assert.equal(connections.length, 0);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  pi.api.events.emit(SPINE_TREE_VIEW_REQUEST, request);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].snapshot.sessionId, "pi-session");
  const ended = [];
  connections[0].attach({ render: () => ["browser"], invalidate() {} }, reason => ended.push(reason));
  assert.deepEqual(widgetLines(ctx.widgets.at(-1)), ["browser"]);
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
  assert.deepEqual(ended, ["invalidated"]);
  pi.api.events.emit(SPINE_TREE_VIEW_REQUEST, request);
  assert.equal(connections.length, 1);
  assert.equal(ctx.aborts, 0);
});

test("widget registration failure does not poison canonical session initialization", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  ctx.context.ui.setWidget = () => { throw new Error("UI unavailable"); };
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  assert.equal(ctx.aborts, 0);
  const event = { systemPrompt: "base", systemPromptOptions: {} };
  await pi.emit("before_agent_start", event, ctx.context);
  assert.ok(event.systemPromptOptions.appendSystemPrompt.length > 0);
  let offered = false;
  pi.api.events.emit(SPINE_TREE_VIEW_REQUEST, { version: 1, sessionId: "pi-session", accept() { offered = true; } });
  assert.equal(offered, false);
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
  assert.equal(ctx.aborts, 0);
});


test("Pi compact rematerializes an edited cached view and admits silent durable messages", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const original = user("original evidence");
  const branch = [{ type: "message", id: "user", parentId: null, timestamp: "1", message: original }];
  ctx.context.sessionManager.getBranch = () => branch;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  assert.deepEqual((await pi.emit("context", { type: "context", messages: [] }, ctx.context)).messages, [{ ...original, content: "[U1]\noriginal evidence" }]);
  await cancelTurn(pi, ctx);
  branch.push({ type: "context_edit", id: "edit", parentId: "user", timestamp: "2", targetId: "user", replacement: { content: [{ type: "text", text: "revised evidence" }] } });
  branch.push({ type: "custom_message", id: "silent", parentId: "edit", timestamp: "2026-01-01T00:00:00Z", customType: "test.silent", content: "durable tail", display: false });
  let requested;
  ctx.context.modelRegistry = { async complete(_model, request) {
    requested = request;
    return { content: [{ type: "text", text: "summary" }] };
  } };
  const result = await pi.emit("session_before_compact", {
    type: "session_before_compact", branchEntries: [...branch], reason: "manual", signal: new AbortController().signal,
    preparation: { firstKeptEntryId: "user", tokensBefore: 12, settings: { reserveTokens: 1000 }, messagesToSummarize: [original], turnPrefixMessages: [] },
  }, ctx.context);
  assert.equal(result.compaction.summary, "summary");
  assert.deepEqual(requested.messages.slice(0, -1), [
    { ...original, content: [{ type: "text", text: "[U1]\nrevised evidence" }] },
    { role: "user", content: [{ type: "text", text: "durable tail" }], timestamp: Date.parse("2026-01-01T00:00:00Z") },
  ]);
  assert.equal(ctx.aborts, 0);
});

test("Pi compact cancels before its barrier when a message arrives during summary", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  const { entry } = compactFixture();
  const branch = [entry];
  ctx.context.sessionManager.getBranch = () => branch;
  createPiExtension()(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const snapshot = [...branch];
  ctx.context.modelRegistry = { async complete() {
    branch.push({ type: "custom_message", id: "late", parentId: entry.id, timestamp: "2026-01-01T00:00:00Z", customType: "test.silent", content: "late evidence", display: false });
    return { content: [{ type: "text", text: "stale summary" }] };
  } };
  const result = await pi.emit("session_before_compact", {
    type: "session_before_compact", branchEntries: snapshot, reason: "manual", signal: new AbortController().signal,
    preparation: { firstKeptEntryId: entry.id, tokensBefore: 12, settings: { reserveTokens: 1000 }, messagesToSummarize: [], turnPrefixMessages: [] },
  }, ctx.context);
  assert.deepEqual(result, { cancel: true });
  assert.equal(pi.entries.some(entry => ["spine.compact.v1", "spine.fault.v1"].includes(entry.customType)), false);
  const context = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(context.messages.map(message => message.role), ["user", "custom"]);
  assert.equal(context.messages[1].content, "late evidence");
  assert.equal(ctx.aborts, 0);
});


test("Pi shutdown cancels an active operation before disposing its runtime", async () => {
  const pi = mockPi();
  const ctx = extensionContext();
  let runtime;
  createPiExtension({ onSessionReady(info) { runtime = info.runtime; } })(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const events = [];
  const dispose = runtime.dispose.bind(runtime);
  runtime.dispose = () => { events.push("dispose"); dispose(); };
  ctx.context.isIdle = () => false;
  ctx.context.abort = () => { events.push("abort"); };
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx.context);
  assert.deepEqual(events, ["abort", "dispose"]);
});

test("Pi request materialization failure aborts instead of returning the last published messages", async () => {
  const pi = mockPi();
  const original = user("evidence before failure");
  const ctx = extensionContext("materialization-fault", {
    branch: [{ type: "message", id: "user", message: original }],
  });
  let runtime;
  createPiExtension({ onSessionReady(info) { runtime = info.runtime; } })(pi.api);
  await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
  const cached = await pi.emit("context", { type: "context", messages: [] }, ctx.context);
  assert.deepEqual(cached.messages, [user("[U1]\nevidence before failure")]);
  await cancelTurn(pi, ctx);
  const entriesBefore = structuredClone(pi.entries);
  runtime.nodePrompt = () => { throw new Error("materialization unavailable"); };
  const failed = await pi.emit("context", { type: "context", messages: cached.messages }, ctx.context);
  assert.deepEqual(failed, { messages: [] });
  assert.equal(ctx.aborts, 1);
  const faults = pi.entries.filter(entry => entry.customType === "spine.fault.v1");
  assert.equal(faults.length, 1);
  assert.equal(faults[0].data.hook, "context");
  assert.deepEqual(faults[0].data.errors, [{ name: "Error", message: "materialization unavailable" }]);
  await assert.rejects(pi.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} }, ctx.context), /faulted/);
  assert.deepEqual(pi.entries.filter(entry => entry.customType !== "spine.fault.v1"), entriesBefore);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx.context);
});
