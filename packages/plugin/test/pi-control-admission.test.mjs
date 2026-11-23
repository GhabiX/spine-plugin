import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

// Override only to validate an isolated build / the installed production host.
const dist = process.env.SPINE_TEST_DIST
  ? pathToFileURL(`${process.env.SPINE_TEST_DIST}/pi/`)
  : new URL("../dist/pi/", import.meta.url);
const { createPiExtension } = await import(new URL("extension.js", dist));
const { PiSamplingLifecycle, PiSpineToolLimitError } = await import(new URL("lifecycle.js", dist));
const { PiSourceBindings } = await import(new URL("messages.js", dist));
const { runToolCall } = await import(process.env.SPINE_TEST_AGENT_CORE ?? "@earendil-works/pi-agent-core");

const INPUTS = {
  spine_open: { goal: "scope" },
  spine_close: { memory: "done" },
  spine_next: { goal: "next", memory: "done" },
  spine_spawn: { tasks: [{ summary: "child a", prompt: "work a" }, { summary: "child b", prompt: "work b" }] },
};

function fixture(t, { inactive = false, fault = false, failStage = false } = {}) {
  const handlers = new Map(), listeners = new Map(), tools = new Map();
  const entries = [], commands = [];
  let aborts = 0, nextCall = 0, runtimeCreations = 0;
  const pi = {
    events: {
      on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); },
      emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); },
    },
    registerFlag() {}, getFlag() { return false; }, registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools() { return [...tools.values()].filter(tool => tool.exposure !== "hidden").map(tool => tool.name); },
    setActiveTools() {},
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  };
  if (inactive) pi.events.on("spinetree:mode", query => { query.mode = "st"; });
  const ctx = {
    cwd: "/tmp", mode: "print", hasUI: false, isIdle: () => true,
    abort() { aborts++; }, ui: { setWidget() {}, notify() {} },
    sessionManager: {
      getSessionId: () => "control-admission", getBranch: () => [], getHeader: () => null,
      getSessionFile: () => undefined,
    },
  };
  createPiExtension({
    runtimeFactory: {
      create(thread) {
        runtimeCreations++;
        const runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
        const execute = runtime.client.execute.bind(runtime.client);
        return { ...runtime, client: { async execute(command) {
          commands.push(command);
          if (failStage && command.type === "stage_execution") throw new Error("controlled transport failure");
          return execute(command);
        } } };
      },
    },
    ...(fault ? { onSessionReady() { throw new Error("controlled readiness failure"); } } : {}),
  })(pi);
  async function emit(name, event = {}) {
    let result;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  }
  t.after(() => emit("session_shutdown"));
  return {
    emit, tools, entries, commands,
    get aborts() { return aborts; }, get runtimeCreations() { return runtimeCreations; },
    faults() { return entries.filter(entry => entry.customType === "spine.fault.v1"); },
    async call(name, input = INPUTS[name], mutate) {
      const toolCall = { id: `call-${++nextCall}`, name, arguments: structuredClone(input) };
      const assistantMessage = { role: "assistant", content: [{ type: "toolCall", ...toolCall }], stopReason: "toolUse", timestamp: 1 };
      let reached = 0, admission;
      const result = await runToolCall(toolCall, {
        assistantMessage,
        context: { messages: [], tools: [...tools.values()] },
        async beforeToolCall({ args }) {
          reached++;
          mutate?.(args); // Pi does not revalidate earlier tool_call handlers' mutations.
          return admission = await emit("tool_call", { toolName: name, toolCallId: toolCall.id, input: args });
        },
        async afterToolCall({ isError }) {
          await emit("tool_result", { toolCallId: toolCall.id, isError });
        },
      });
      return { ...result, admission, reached };
    },
  };
}

for (const name of Object.keys(INPUTS)) {
  test(`Pi control admission: already faulted ${name} is an ordinary refusal, without aborting again`, async t => {
    const f = fixture(t, { fault: true });
    await f.emit("session_start");
    assert.equal(f.aborts, 1);
    const before = f.commands.length;
    const result = await f.call(name);
    assert.equal(result.reached, 1);
    assert.deepEqual(result.admission, { block: true, reason: "Spine durability is faulted: controlled readiness failure" });
    assert.equal(result.isError, true);
    assert.equal(result.result.terminate, undefined);
    assert.equal(f.aborts, 1);
    assert.equal(f.faults().length, 1);
    assert.equal(f.commands.length, before);
  });
}

for (const [name, input] of [["spine_open", {}], ["spine_spawn", { tasks: [] }], ["spine_spawn", { tasks: INPUTS.spine_spawn.tasks.slice(0, 1) }]]) {
  test(`Pi control admission: host schema rejects ${name} ${JSON.stringify(input)} before admission`, async t => {
    const f = fixture(t);
    await f.emit("session_start");
    await f.emit("context");
    const result = await f.call(name, input);
    assert.equal(result.isError, true);
    assert.equal(result.reached, 0);
    assert.match(result.result.content[0].text, /Validation failed/);
    assert.equal(f.aborts, 0);
    assert.equal(f.faults().length, 0);
    assert.equal(f.commands.some(command => command.type === "register_execution"), false);
  });
}

for (const name of ["spine_open", "spine_spawn"]) {
  test(`Pi control admission: SDK rejects mutated ${name} input without consuming admission or faulting`, async t => {
    const f = fixture(t);
    await f.emit("session_start");
    await f.emit("context");
    const result = await f.call(name, INPUTS[name], args => {
      if (name === "spine_open") args.goal = "";
      else args.tasks[0].summary = "";
    });
    assert.equal(result.reached, 1);
    assert.equal(result.isError, true);
    assert.match(result.admission.reason, /empty/);
    assert.equal(result.result.terminate, undefined);
    assert.equal(f.commands.some(command => command.type === "register_execution"), false);
    assert.equal((await f.call("spine_open")).isError, false);
    assert.equal(f.aborts, 0);
    assert.equal(f.faults().length, 0);
  });
}

test("Pi control admission: host coercion precedes strict SDK input validation", async t => {
  const f = fixture(t);
  await f.emit("session_start");
  await f.emit("context");
  assert.equal((await f.call("spine_open", { goal: 42 })).isError, false);
  assert.equal(f.commands.find(command => command.type === "stage_execution").operation.summary, "42");
  assert.equal(f.faults().length, 0);
});

for (const name of ["spine_close", "spine_next"]) {
  test(`Pi control admission: root ${name} business refusal does not fault or reserve an operation`, async t => {
    const f = fixture(t);
    await f.emit("session_start");
    await f.emit("context");
    const result = await f.call(name);
    assert.equal(result.isError, true);
    assert.match(result.admission.reason, /at the root/);
    assert.equal(result.result.terminate, undefined);
    assert.equal(f.commands.some(command => command.type === "register_execution"), false);
    assert.equal((await f.call("spine_open")).isError, false);
    assert.equal(f.aborts, 0);
    assert.equal(f.faults().length, 0);
  });
}

test("Pi control admission: inactive ST mode hides open and spawn equally; hooks leave SDK untouched", async t => {
  const f = fixture(t, { inactive: true });
  await f.emit("session_start");
  for (const name of ["spine_open", "spine_spawn"]) {
    assert.equal(f.tools.get(name).exposure, "hidden");
    assert.equal(await f.emit("tool_call", { toolName: name, toolCallId: name, input: INPUTS[name] }), undefined);
  }
  assert.equal(f.runtimeCreations, 0);
  assert.equal(f.entries.length, 0);
  assert.equal(f.aborts, 0);
});

for (const name of ["spine_open", "spine_spawn"]) {
  test(`Pi control admission: ${name} outside sampling is still a lifecycle invariant fault`, async t => {
    const f = fixture(t);
    await f.emit("session_start");
    const result = await f.call(name);
    assert.deepEqual(result.admission, { block: true, reason: "Spine lifecycle fault", terminate: true });
    assert.equal(f.aborts, 1);
    assert.equal(f.faults().length, 1);
    assert.match(f.faults()[0].data.errors.at(-1).message, /outside sampling/);
  });
}

for (const names of [["spine_spawn", "spine_open"], ["spine_open", "spine_spawn"]]) {
  test(`Pi control admission: concurrent ${names.join(" / ")} reserves only one operation`, async t => {
    const f = fixture(t);
    await f.emit("session_start");
    await f.emit("context");
    const results = await Promise.all(names.map(name => f.call(name)));
    assert.equal(results.filter(result => !result.isError).length, 1);
    assert.match(results.find(result => result.isError).admission.reason, /only one Spine tool call/);
    assert.equal(f.commands.filter(command => command.type === "register_execution").length, 1);
    assert.equal(f.commands.filter(command => command.type === "stage_execution").length, 1);
    assert.equal(f.aborts, 0);
    assert.equal(f.faults().length, 0);
  });
}

test("Pi control admission: reservation is synchronous even while registerExecution is suspended", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commands = [];
  const lifecycle = new PiSamplingLifecycle({
    fault: null,
    async beginSampling() {},
    async registerExecution(key) { commands.push(key); await gate; },
    async stageExecution() {},
  }, new PiSourceBindings(), { schema: "spine.source.snapshot.v1", thread: "control-admission", epoch: 0, cells: [] });
  await lifecycle.beginSampling();
  const first = lifecycle.registerToolCall("first", "spine_spawn", INPUTS.spine_spawn);
  try {
    await assert.rejects(lifecycle.registerToolCall("second", "spine_open", INPUTS.spine_open), PiSpineToolLimitError);
  } finally { release(); }
  await first;
  assert.deepEqual(commands, ["first"]);
  assert.equal(lifecycle.fault, null);
});

test("Pi control admission: real SDK controller runtime errors remain fatal, not tool-input refusals", async t => {
  const f = fixture(t, { failStage: true });
  await f.emit("session_start");
  await f.emit("context");
  const result = await f.call("spine_spawn");
  assert.deepEqual(result.admission, { block: true, reason: "Spine lifecycle fault", terminate: true });
  assert.equal(f.aborts, 1);
  assert.equal(f.faults().length, 1);
  assert.deepEqual(f.faults()[0].data.errors.map(error => error.name), ["PiSamplingLifecycleError", "SpineControllerError", "Error"]);
  assert.match(f.faults()[0].data.errors.at(-1).message, /controlled transport failure/);
  const later = await f.call("spine_spawn");
  assert.match(later.admission.reason, /^Spine durability is faulted:/);
  assert.equal(later.result.terminate, undefined);
  assert.equal(f.aborts, 1);
});
