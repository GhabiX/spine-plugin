import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SpineTreeBrowser } from "../dist/pi/navigation/browser.js";
import { registerSpineTreeNavigation } from "../dist/pi/navigation/index.js";

const plain = text => text;
const markdownTheme = Object.fromEntries([
  "heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder",
  "hr", "listBullet", "bold", "italic", "strikethrough", "underline",
].map(key => [key, plain]));
const keybindings = { matches: (input, action) => input === action, getKeys: action => [action] };
const node = (id, parent, children = [], status = "Closed") => ({ id, parent, children, summary: `任务 ${id}`, status, kind: parent === null ? "RootEpoch" : "Task" });
function fixture(cursor = "1.2") {
  const data = {
    nodes: [node("1", null, ["1.1", "1.2"]), node("1.1", "1", ["1.1.1"], "Opened"), node("1.1.1", "1.1"), node("1.2", "1")],
    cursor,
    memorySections: (id, full) => [`${full ? "Full returned memory" : "Own summary"} ${id}\n\n${Array.from({ length: 30 }, (_, i) => `memory line ${i}`).join("\n\n")}`],
  };
  let closed = 0;
  const browser = new SpineTreeBrowser({ data, theme: { fg: (_color, text) => text, bold: text => text }, markdownTheme, keybindings, redraw() {}, close() { closed++; } });
  return { browser, data, closed: () => closed };
}

test("opens with the cursor's path and children expanded, as the bottom tree shows", () => {
  const output = stripTerminalSequences(fixture("1").browser.render(80, 20).join("\n"));
  assert.match(output, /1\.1 /);
  assert.match(output, /1\.2 /);
  assert.doesNotMatch(output, /1\.1\.1/);
});

test("navigation keeps node identity and closes memory and tree in two stages", () => {
  const { browser, data, closed } = fixture();
  const before = JSON.stringify(data.nodes);
  assert.doesNotMatch(browser.render(80, 20).join("\n"), /History|block/);
  browser.handleInput("tui.select.confirm");
  assert.match(browser.render(80, 20).join("\n"), /Own summary 1\.2/);
  browser.handleInput("tui.input.tab");
  assert.match(browser.render(80, 20).join("\n"), /Full returned memory 1\.2/);
  browser.handleInput("tui.select.cancel");
  assert.equal(closed(), 0);
  browser.handleInput("tui.select.cancel");
  assert.equal(closed(), 1);
  assert.equal(JSON.stringify(data.nodes), before);
  assert.equal(data.cursor, "1.2");
});

test("Tab switches memory scope only while reading; tree selection never changes session", () => {
  const { browser, closed } = fixture();
  browser.handleInput("tui.input.tab");
  assert.equal(closed(), 0);
  assert.doesNotMatch(browser.render(80, 20).join("\n"), /Own summary/);
  browser.handleInput("tui.select.confirm");
  browser.handleInput("tui.input.tab");
  assert.match(browser.render(80, 20).join("\n"), /Full returned memory/);
});

test("collapsed descendants remain accessible", () => {
  const { browser } = fixture();
  browser.handleInput("tui.select.up");
  assert.match(stripTerminalSequences(browser.render(80, 20).join("\n")), />.*1\.1/);
  browser.handleInput("tui.editor.cursorRight");
  browser.handleInput("tui.editor.cursorRight");
  let lines = browser.render(80, 20);
  assert.match(stripTerminalSequences(lines.join("\n")), />.*1\.1\.1/);
  browser.handleInput("tui.select.confirm");
  assert.match(browser.render(80, 20).join("\n"), /Own summary 1\.1\.1/);
  browser.handleInput("tui.select.cancel");
  browser.handleInput("tui.editor.cursorLeft");
  browser.handleInput("tui.editor.cursorLeft");
  lines = browser.render(80, 20);
  assert.ok(!lines.some(line => line.includes("任务 1.1.1")));
});

test("tree mode contains no transcript metadata", () => {
  const { browser } = fixture();
  const lines = browser.render(80, 16);
  assert.doesNotMatch(lines.join("\n"), /History|block|entry-/);
});

test("page keys do nothing in tree mode and still page memory", () => {
  const { browser } = fixture();
  const before = browser.render(80, 20).join("\n");
  browser.handleInput("tui.select.pageDown");
  assert.equal(browser.render(80, 20).join("\n"), before);
  browser.handleInput("tui.select.confirm");
  const first = browser.render(80, 20).join("\n");
  browser.handleInput("tui.select.pageDown");
  assert.notEqual(browser.render(80, 20).join("\n"), first);
});

test("reader remains above tree with bounded output on resize and long memory", () => {
  const { browser } = fixture();
  const history = browser.render(80, 18);
  assert.ok(history.some(line => line.includes("Spine Tree")));
  assert.ok(history.some(line => line.includes("├") || line.includes("└")));
  assert.ok(history.some(line => line.includes("◉") && line.includes("1.2")));
  browser.handleInput("tui.select.confirm");
  const memory = browser.render(80, 18);
  assert.ok(memory.findIndex(line => line.includes("Spine Tree")) > memory.findIndex(line => line.includes("Own summary")));
  for (let i = 0; i < 20; i++) browser.handleInput("tui.select.pageDown");
  for (const [width, height] of [[20, 9], [60, 14], [1, 1], [80, 18]]) {
    const lines = browser.render(width, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.match(browser.render(80, 18).join("\n"), /memory line 29/);
});

test("memory reader advances across sections without joining them into one document", () => {
  const data = {
    nodes: [node("1", null)],
    cursor: "1",
    memorySections: () => ["First section", "Second section"],
  };
  const browser = new SpineTreeBrowser({
    data,
    theme: { fg: (_color, text) => text, bold: text => text },
    markdownTheme,
    keybindings,
    redraw() {},
    close() {},
  });
  browser.handleInput("tui.select.confirm");
  assert.match(browser.render(60, 12).join("\n"), /First section/);
  for (let i = 0; i < 5; i++) browser.handleInput("tui.select.pageDown");
  assert.match(browser.render(60, 12).join("\n"), /Second section/);
});

function extensionHarness(offers) {
  const commands = new Map();
  const notices = [];
  let widgetWrites = 0;
  registerSpineTreeNavigation({ registerCommand: (name, command) => commands.set(name, command),
    events: { emit: (channel, request) => { if (channel === "spinejit:tree-view:v1") offers(request); } } });
  const ctx = {
    cwd: "/isolated-navigation", mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    navigateTree: async () => assert.fail("browsing must not switch the execution session"),
    ui: { notify: (text, severity) => notices.push({ text, severity }), setWidget() { widgetWrites++; }, custom() { assert.fail("must not open a custom UI"); } },
  };
  return { commands, ctx, notices, writes: () => widgetWrites };
}

test("command refuses missing, multiple and wrong-session core offers without widget writes", async () => {
  for (const offers of [() => {}, request => { request.accept({}); request.accept({}); }, request => request.accept({ version: 1, snapshot: { sessionId: "other" } })]) {
    const { commands, ctx, notices, writes } = extensionHarness(offers);
    assert.deepEqual([...commands.keys()], ["spine-tree"]);
    await commands.get("spine-tree").handler("", ctx);
    assert.equal(notices.length, 1);
    assert.equal(writes(), 0);
  }
});

test("command refuses RPC custom even when hasUI is true", async () => {
  const { commands, ctx, notices } = extensionHarness(() => assert.fail("must not request a connection"));
  ctx.mode = "rpc";
  await commands.get("spine-tree").handler("", ctx);
  assert.equal(notices.length, 1);
});

test("core invalidation ends custom, releases view, and permits reopening", async () => {
  let releaseCount = 0;
  let lastView;
  let end;
  const connection = {
    version: 1,
    snapshot: { sessionId: "session", generation: 1, cursor: [1], nodes: [{ id: [1], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: null, memory: null, start: 0, end: null }] },
    attach(view, onEnd) {
      lastView = view; end = onEnd;
      let released = false;
      return { redraw() {}, release() { if (!released) { released = true; releaseCount++; onEnd("released"); } } };
    },
  };
  const { commands, ctx, writes } = extensionHarness(request => request.accept(connection));
  let control;
  ctx.ui.custom = factory => new Promise(resolve => {
    control = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, keybindings, () => { resolve(); control?.dispose(); });
  });
  const running = commands.get("spine-tree").handler("", ctx);
  assert.ok(lastView);
  end("invalidated");
  await running;
  assert.equal(releaseCount, 1);
  const reopened = commands.get("spine-tree").handler("", ctx);
  control.handleInput("tui.input.tab");
  control.handleInput("tui.select.confirm");
  control.handleInput("tui.input.tab");
  control.handleInput("tui.select.cancel");
  control.handleInput("tui.select.cancel");
  await reopened;
  assert.equal(releaseCount, 2);
  assert.equal(writes(), 0);
});

test("shared green branding and marker colors survive selection; help wraps without losing exit", () => {
  const { browser } = fixture();
  const lines = browser.render(80, 20);
  assert.ok(lines.some(line => line.includes("\x1b[92mSpine Tree")));
  assert.ok(lines.some(line => line.startsWith(">") && line.includes("\x1b[92m◉")));
  assert.ok(lines.some(line => stripTerminalSequences(line).includes("    ├")));
  const controls = browser.renderControls(32);
  assert.match(controls.join(" "), /exit/);
  assert.ok(controls.every(line => visibleWidth(line) <= 32));
});

test("opened nodes render one shared disclosure/status marker", () => {
  const { browser } = fixture();
  let output = stripTerminalSequences(browser.render(80, 20).join("\n"));
  assert.match(output, /▸.*1\.1/);
  assert.doesNotMatch(output, /▾▾|▸▾/);
  browser.handleInput("tui.select.up");
  browser.handleInput("tui.editor.cursorRight");
  output = stripTerminalSequences(browser.render(80, 20).join("\n"));
  assert.match(output, /▾.*1\.1/);
  assert.doesNotMatch(output, /▾▾|▸▾/);
});
