// The Spine tree DSH shows: the terminal's three rows, the session records
// clients fold, and the browser dock that draws them.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { pluginRecordOf } from "@deepseek-ai/dsh-session";
import { formatPrettySpineTreeFromNodes } from "@spinejit/spine-sdk/view";

import { TreeDisplay, treeProjection } from "../dist/display.js";
import { TREE_RECORD, treeWindow } from "../dist/tree.js";
import { mountDsh } from "./harness.mjs";

function node(nodeId, parentId, summary, status, kind = "Task") {
  return { nodeId, parentId, kind, status, summary, spawn: null };
}

const deep = {
  cursor: "1.2.1",
  nodes: [
    node("1", null, "root task", "Opened"),
    node("1.1", "1", "first step", "Closed"),
    node("1.2", "1", "second step", "Opened"),
    node("1.2.1", "1.2", "deep step", "Live"),
  ],
};
const text = (line) => line.type === "node" ? `${line.prefix}${line.marker} ${line.label}` : line.type;

/** A session's projection value: the tree it recorded, and whether its log began before Spine. */
const viewOf = (tree, legacy = false) => ({ tree, legacy });

test("the terminal window keeps the cursor's row within three rows", () => {
  // Without the header the tree has four rows; the root task's is cut.
  assert.deepEqual(treeWindow(deep, 3).map(text), ["    ├ ✓ first step", "    └ ▾ second step", "      └ ◉ deep step"]);
  const top = { cursor: "1", nodes: [node("1", null, "root", "Live"), ...["a", "b", "c", "d"].map((id) => node(`1.${id}`, "1", id, "Opened"))] };
  const rows = treeWindow(top, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].type === "node" && rows[0].current, true, "the cursor at the top starts the window");
  for (const cursor of ["1", "1.1", "1.2", "1.2.1"]) {
    const window = treeWindow({ ...deep, cursor }, 3);
    assert.equal(window.length <= 3, true);
    assert.equal(window.some((line) => line.type === "node" && line.current), true, `cursor ${cursor} is shown`);
  }
  assert.deepEqual(treeWindow({ cursor: "1", nodes: [node("1", null, "only", "Live")] }, 3).map(text), ["  └ ◉ only"]);
  // At the root epoch, which is never drawn, the newest rows: the task just closed stays in view.
  const epoch = { cursor: "1", nodes: [node("1", null, null, "Live", "RootEpoch"), ...["a", "b", "c", "d"].map((id) => node(`1.${id}`, "1", id, "Closed"))] };
  assert.equal(treeWindow(epoch, 3).at(-1).label, "d");
});

test("the terminal shows the top-level session opened last, never a subagent's, and falls back when it closes", () => {
  const display = new TreeDisplay();
  let emits = 0;
  display.subscribe(() => { emits += 1; });
  const record = (tree) => ({ seq: 1, time: 0, type: TREE_RECORD, ignorable: true, data: tree });
  const session = (id, events = [], origin) => ({ id, header: origin === undefined ? {} : { origin }, snapshotEvents: () => events });
  display.open(session("main", [record(deep), record({ cursor: 1 })]));
  assert.deepEqual(display.shown(), deep, "a resumed session shows its last readable record at once");
  assert.equal(display.shown(), display.shown(), "the same object until it changes");
  display.open(session("child", [], "subagent"));
  assert.deepEqual(display.shown(), deep, "a subagent does not take the terminal");
  display.open(session("fork"));
  assert.equal(display.shown(), null, "a new top-level session shows its own, empty tree");
  const before = emits;
  display.close("fork");
  assert.equal(emits, before + 1);
  assert.deepEqual(display.shown(), deep, "closing it shows the session before it again");
  display.close("child");
  assert.equal(emits, before + 1, "closing a session not shown changes nothing shown");
});

test("the terminal rows show the session's tree, draw markers with theme colors, and wait for a task", async () => {
  const dsh = await mountDsh([[["spine_open", { goal: "inspect" }]], "done"]);
  try {
    const views = [];
    dsh.ctx.provide("tuiStatus");
    dsh.ctx.set("tuiStatus", { registerView: (descriptor) => { views.push(descriptor); return () => {}; } });
    // The plugin's view registration waits for the service, as it waits for dsh-tui.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(views.map(({ key, maxRows }) => [key, maxRows]), [["spinejit:tree", 3]]);
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    };
    const rows = () => views[0].component({ React, ui: { Box: "Box", Text: "Text" } });
    assert.equal(rows(), null);
    await dsh.run("start");
    const box = rows();
    assert.equal(box.type, "Box");
    const flat = (element) => typeof element === "string" ? element : element.children.map(flat).join("");
    assert.deepEqual(box.children.map(flat), ["  └ ◉ inspect"]);
    const [prefix, marker] = box.children[0].children;
    assert.deepEqual(prefix.props, { dimColor: true });
    assert.deepEqual(marker.props, { color: "success", bold: true });
  } finally {
    await dsh.dispose();
  }
});

test("the projection folds the latest readable tree record and ignores the rest", () => {
  const state = treeProjection.init();
  assert.deepEqual(state, { tree: null, legacy: false, sampling: false });
  const other = { seq: 1, type: "turn/end", data: {} };
  assert.equal(treeProjection.apply(state, other), state);
  const record = (seq, data) => ({ seq, time: 0, type: TREE_RECORD, ignorable: true, data });
  assert.equal(pluginRecordOf(record(2, deep))?.type, TREE_RECORD);
  const folded = treeProjection.apply(state, record(2, deep));
  assert.deepEqual(folded.tree, deep);
  assert.equal(treeProjection.apply(folded, other), folded, "an unrelated event keeps the same state");
  assert.equal(treeProjection.apply(folded, record(3, { cursor: 1 })), folded, "an unreadable record keeps the tree");
  assert.deepEqual(treeProjection.wire.viewSchema.parse(treeProjection.wire.view(folded)), viewOf(deep));
});

test("a log that began before Spine folds to legacy without an agent running in it", async () => {
  const fold = (events) => events.reduce((state, event) => treeProjection.apply(state, event), treeProjection.init());
  const before = await mountDsh(["reply"], { plugin: false });
  let legacyEvents;
  try {
    legacyEvents = (await before.run("hello")).session.snapshotEvents();
  } finally {
    await before.dispose();
  }
  assert.equal(fold(legacyEvents).legacy, true,
    "a response with no Spine sampling in front of it is history this plugin never observed");

  const fresh = await mountDsh([[["spine_open", { goal: "A" }]], "done"]);
  let freshEvents;
  try {
    freshEvents = (await fresh.run("start")).session.snapshotEvents();
  } finally {
    await fresh.dispose();
  }
  assert.equal(fold(freshEvents).legacy, false, "a session Spine ran from its first turn is never legacy");
});

test("each change of the shown tree is recorded once, a resumed session records none again, and the projection serves it", async () => {
  const replies = [[["spine_open", { goal: "inspect" }]], [["spine_close", { memory: "found it" }]], "done", "ok"];
  const first = await mountDsh(replies);
  let id;
  let trees;
  try {
    const agent = await first.run("start");
    await first.send(agent, "more");
    id = agent.id;
    trees = first.events(agent).map(pluginRecordOf).filter((record) => record?.type === TREE_RECORD).map((record) => record.data);
    const shown = trees.map((tree) => JSON.stringify(tree));
    assert.deepEqual(shown, [...new Set(shown)], "no tree is recorded twice");
    assert.deepEqual(trees.map((tree) => formatPrettySpineTreeFromNodes(tree.cursor, tree.nodes).slice(1)), [
      ["  └ (empty)"],
      ["  └ ◉ inspect"],
      ["  └ ✓ inspect"],
    ]);
    assert.deepEqual(first.ctx.sessionProjections.stateOf(agent.session, "spinejit").tree, trees.at(-1));
  } finally {
    await first.dispose();
  }
  const second = await mountDsh(["again"], { root: first.root });
  try {
    const agent = await second.resume(id);
    await second.send(agent, "next");
    const records = agent.session.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === TREE_RECORD);
    assert.deepEqual(records.map((record) => record.data), trees, "the resumed session's tree did not change");
  } finally {
    await second.dispose();
  }
});

test("a user bubble hides the [U<n>] line its text starts with, and only that", async () => {
  const { client: { userAnchorRule: rule } } = await loadClient();
  assert.deepEqual(rule.match("[U1]\nhow does it work?", 0), { id: "text", start: 0, end: 5, data: { text: "[U1]\n", display: "" } });
  assert.deepEqual(rule.match("[U12]\n", 0), { id: "text", start: 0, end: 6, data: { text: "[U12]\n", display: "" } });
  assert.equal(rule.match("[U1]\nhow", 5), undefined, "only at the start");
  assert.equal(rule.match("see [U1]\nabove", 0), undefined);
  assert.equal(rule.match("[U1] inline", 0), undefined, "the number is its own line");
  assert.equal(rule.match("[Ux]\nnot a number", 0), undefined);
  assert.equal(rule.match("plain", 0), undefined);
});

const PRIMITIVES = {
  Button: "button",
  Tooltip: "span",
  StateDot: "span",
  IconBranchOutlineRegular: "svg",
  IconChevronDownOutlineRegular: "svg",
  IconChevronRightOutlineRegular: "svg",
  IconChevronUpOutlineRegular: "svg",
  IconCheckCircleOutlineRegular: "svg",
  IconCloseCircleFillRegular: "svg",
  IconCompactOutlineRegular: "svg",
  IconInspectOutlineRegular: "svg",
  IconStopFillRegular: "svg",
  IconWarningTriangleOutlineRegular: "svg",
};

function createReactRuntime() {
  let hooks = [];
  let cursor = 0;
  let component = null;
  let props = null;
  let output = null;
  let rendering = false;

  const element = (type, elementProps, key) => ({
    type,
    props: elementProps ?? {},
    key: key ?? null,
  });
  const sameDeps = (previous, next) =>
    previous !== undefined
    && next !== undefined
    && previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));

  const React = {
    useState(initial) {
      const slot = cursor++;
      if (hooks[slot] === undefined) {
        hooks[slot] = { value: typeof initial === "function" ? initial() : initial };
      }
      return [hooks[slot].value, (next) => {
        hooks[slot].value = typeof next === "function" ? next(hooks[slot].value) : next;
        render();
      }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (hooks[slot] === undefined) hooks[slot] = { value: { current: initial } };
      return hooks[slot].value;
    },
    useEffect(effect, deps) {
      const slot = cursor++;
      const previous = hooks[slot];
      if (previous !== undefined && sameDeps(previous.deps, deps)) return;
      if (typeof previous?.cleanup === "function") previous.cleanup();
      hooks[slot] = { deps, cleanup: effect() };
    },
    useCallback(callback) {
      cursor += 1;
      return callback;
    },
    useMemo(factory) {
      cursor += 1;
      return factory();
    },
  };

  function render() {
    if (rendering) throw new Error("nested render");
    rendering = true;
    cursor = 0;
    output = component(props);
    rendering = false;
  }

  return {
    React,
    mount(nextComponent, nextProps) {
      component = nextComponent;
      props = nextProps;
      hooks = [];
      output = null;
      render();
      return {
        tree: () => output,
        setProps(next) {
          props = next;
          render();
        },
      };
    },
  };
}

/** dist/client.js as the web client's module loader runs it, with host React and atom stubs. */
async function loadClient() {
  const source = await readFile(new URL("../dist/client.js", import.meta.url), "utf8");
  let loaded;
  const window = { __ModuleLoader__: { load: (module) => { loaded = module; } } };
  new Function("window", source)(window);
  const runtime = createReactRuntime();
  const required = [];
  const elem = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
  const client = loaded.factory((name) => {
    required.push(name);
    if (name === "react") return runtime.React;
    if (name === "react/jsx-runtime") return { jsx: elem, jsxs: elem };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return PRIMITIVES;
    throw new Error(`unexpected module request: ${name}`);
  });
  return { id: loaded.id, client, required, runtime };
}

function registerDock(client) {
  const entries = [];
  const rules = [];
  const blocks = [];
  const sessions = [];
  client.apply({
    slots: { inject: (_name, register) => register(), register: (entry, component) => entries.push([entry, component]) },
    uiConversation: { userText: { register: (rule) => { rules.push(rule); return () => {}; } } },
    conversation: { blocks: { set: (sessionId, block) => { blocks.push([sessionId, block]); } } },
    uiWorkspace: { startSession: () => { sessions.push(true); } },
    effect: (execute) => execute(),
  });
  assert.equal(entries.length, 1, "the client registers exactly one dock entry");
  return { entry: entries[0][0], Dock: entries[0][1], rules, blocks, sessions };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function nodesWhere(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesWhere(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  nodesWhere(node.props?.children, predicate, out);
  return out;
}

function headerOf(tree) {
  const header = nodesWhere(tree, (node) => node.props.className === "sj-header")[0];
  assert.ok(header, "the dock header is rendered");
  return header;
}

function rowsOf(tree) {
  return nodesWhere(tree, (node) => node.props.className === "sj-row");
}

const click = (node) => node.props.onClick();

test("the client bundle carries the dock's stylesheet, since the web client loads only the module", async () => {
  const loaded = await loadClient();
  const { Dock } = registerDock(loaded.client);
  const tree = loaded.runtime.mount(Dock, { useProjection: () => viewOf(deep) }).tree();
  const style = nodesWhere(tree, (node) => node.type === "style")[0];
  assert.ok(style, "the dock renders its stylesheet");
  assert.match(style.props.children, /\.sj-dock\{/);
  assert.match(style.props.children, /\.sj-row\[data-current="true"\]\{/);
  assert.deepEqual(
    (await readdir(new URL("../dist", import.meta.url))).filter((name) => name.endsWith(".css")),
    [],
    "no stylesheet file is emitted for a page that would not load it",
  );
});

test("the client's types and the shared contract they import are shipped inside dist", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./client"].types, "./dist/client/client.d.ts");
});

test("the client bundle loads in the module loader and registers the dock beside the anchor rule", async () => {
  const { id, client, required, runtime } = await loadClient();
  assert.equal(id, "@spinejit/dsh-spinejit");
  assert.deepEqual(
    [...new Set(required)].sort(),
    ["@deepseek-ai/dsh-client-ui-primitives", "react", "react/jsx-runtime"],
  );
  assert.deepEqual(client.inject, ["slots", "uiConversation", "conversation", "uiWorkspace"]);
  const { entry, Dock, rules } = registerDock(client);
  assert.deepEqual(rules, [client.userAnchorRule], "the user-anchor rule is registered");
  assert.deepEqual(entry, { name: "conversation.input.dock", id: "spinejit", order: 30, registrant: "@spinejit/dsh-spinejit" });

  assert.equal(runtime.mount(Dock, { useProjection: () => undefined }).tree(), null,
    "no projection capability means no dock");
  const waiting = runtime.mount(Dock, { useProjection: () => viewOf(null) });
  assert.equal(textOf(waiting.tree()).includes("Waiting for the first Spine task"), true,
    "a registered projection without a tree shows the waiting bar");
  click(headerOf(waiting.tree()));
  assert.equal(textOf(waiting.tree()).includes("appears after Spine opens its first task"), true,
    "the waiting bar explains when the tree arrives");
});

test("a session whose log began before Spine is left inert, with the reason and a way to start over", async () => {
  const loaded = await loadClient();
  const { Dock, blocks, sessions } = registerDock(loaded.client);
  const runtime = loaded.runtime;
  const epoch = { cursor: "1", nodes: [node("1", null, null, "Live", "RootEpoch")] };
  const dock = runtime.mount(Dock, { useProjection: () => viewOf(epoch, true), sessionId: "session-1" });

  assert.deepEqual(blocks, [["session-1", {
    reason: "This session began before Spine. Start a new session to continue.",
  }]], "the composer is blocked with the reason it shows as its placeholder");
  assert.equal(textOf(headerOf(dock.tree())).includes("Started before Spine"), true,
    "the bar says the session predates Spine instead of waiting for a task");
  assert.equal(textOf(dock.tree()).includes("Waiting for the first Spine task"), false);

  click(headerOf(dock.tree()));
  const tree = dock.tree();
  assert.equal(textOf(tree).includes("This session's history is outside the Spine tree."), true,
    "the dock explains why the tree does not cover it");
  assert.equal(textOf(tree).includes("appears after Spine opens its first task"), false,
    "a legacy session is not told to wait for a task");
  click(nodesWhere(tree, (node) => node.type === "button" && textOf(node) === "New session")[0]);
  assert.equal(sessions.length, 1, "the notice opens a new session");

  // The block is page-local: a session the host no longer calls legacy clears it.
  dock.setProps({ useProjection: () => viewOf(deep), sessionId: "session-1" });
  assert.deepEqual(blocks.at(-1), ["session-1", undefined], "leaving the legacy session clears the block");
});

test("the dock starts collapsed on the cursor and expands into the whole tree", async () => {
  const loaded = await loadClient();
  const { Dock } = registerDock(loaded.client);
  const runtime = loaded.runtime;
  const keys = [];
  const dock = runtime.mount(Dock, {
    useProjection: (key) => {
      keys.push(key);
      return viewOf(deep);
    },
  });
  assert.deepEqual(keys, ["spinejit"]);
  let tree = dock.tree();
  assert.equal(headerOf(tree).props["aria-expanded"], "false");
  assert.equal(textOf(headerOf(tree)).includes("deep step"), true, "the collapsed summary is the cursor's");
  assert.equal(rowsOf(tree).length, 0, "no tree rows while collapsed");

  click(headerOf(tree));
  tree = dock.tree();
  assert.equal(headerOf(tree).props["aria-expanded"], "true");
  assert.equal(rowsOf(tree).length, 4, "every node is drawn");
  assert.equal(textOf(tree).includes("first step"), true);
  assert.equal(textOf(tree).includes("detail"), false, "the dock offers no node detail");
  assert.deepEqual(
    nodesWhere(tree, (node) => node.props["aria-label"] !== undefined && node.props.role === "img")
      .map((node) => node.props["aria-label"]),
    ["Opened", "Closed", "Opened", "Live"],
    "status markers keep accessible names",
  );
  const current = rowsOf(tree).find((row) => row.props["data-current"] === "true");
  assert.ok(current, "the cursor row is marked");
  assert.equal(current.props["aria-current"], "step");
  assert.equal(current.props.onClick, undefined, "browsing a row does not execute anything");
});

test("branches fold, survive projection updates, and the locate button reveals the cursor", async () => {
  const loaded = await loadClient();
  const { Dock } = registerDock(loaded.client);
  const runtime = loaded.runtime;
  const dock = runtime.mount(Dock, { useProjection: () => viewOf(deep) });
  click(headerOf(dock.tree()));
  let tree = dock.tree();
  const caret = nodesWhere(tree, (node) => node.props.className === "sj-caret")
    .find((node) => node.props["aria-label"].includes("second step"));
  assert.ok(caret, "the second step branch has a caret");
  click(caret);
  assert.equal(rowsOf(dock.tree()).length, 3, "the folded branch hides its child");

  dock.setProps({ useProjection: () => viewOf({ ...deep }) });
  assert.equal(rowsOf(dock.tree()).length, 3, "a new projection value keeps the user's folding");
  assert.equal(headerOf(dock.tree()).props["aria-expanded"], "true", "a new projection value keeps the dock open");

  const locate = nodesWhere(dock.tree(), (node) => node.props.className === "sj-locateWrap")[0];
  assert.ok(locate, "the locate control is shown while expanded");
  click(nodesWhere(locate, (node) => node.type === "button")[0]);
  assert.equal(rowsOf(dock.tree()).length, 4, "locating expands the cursor's ancestors");
});

test("the whole tree keeps root epochs and shows spawn outcomes", async () => {
  const loaded = await loadClient();
  const { Dock } = registerDock(loaded.client);
  const runtime = loaded.runtime;
  const tree = {
    cursor: "1.2",
    nodes: [
      node("1", null, null, "Compacted", "RootEpoch"),
      { ...node("1.1", "1", "inherited work", "Opened"), spawn: "inherited" },
      { ...node("1.2", "1", "arrived work", "Closed", "Spawn"), spawn: { arrived: "completed" } },
    ],
  };
  const dock = runtime.mount(Dock, { useProjection: () => viewOf(tree) });
  click(headerOf(dock.tree()));
  const rows = rowsOf(dock.tree());
  assert.deepEqual(rows.map(textOf), ["Epoch 1", "inherited work", "arrived work"]);
  assert.deepEqual(
    rows.map((row) => nodesWhere(row, (part) => part.props.role === "img")[0].props["aria-label"]),
    ["Root epoch", "Inherited spawn", "Spawn completed"],
  );
});

