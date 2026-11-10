// The Spine tree DSH shows: the terminal's three rows, the session records
// clients fold, and the browser dock that draws them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.equal(state, null);
  const other = { seq: 1, type: "turn/end", data: {} };
  assert.equal(treeProjection.apply(state, other), state);
  const record = (seq, data) => ({ seq, time: 0, type: TREE_RECORD, ignorable: true, data });
  assert.equal(pluginRecordOf(record(2, deep))?.type, TREE_RECORD);
  const folded = treeProjection.apply(state, record(2, deep));
  assert.deepEqual(folded, deep);
  assert.equal(treeProjection.apply(folded, other), folded, "an unrelated event keeps the same state");
  assert.equal(treeProjection.apply(folded, record(3, { cursor: 1 })), folded, "an unreadable record keeps the tree");
  assert.deepEqual(treeProjection.wire.viewSchema.parse(folded), deep);
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
    assert.deepEqual(first.ctx.sessionProjections.stateOf(agent.session, "spinejit"), trees.at(-1));
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

/** dist/client.js as the web client's module loader runs it, with a JSX runtime that builds plain objects. */
async function loadClient() {
  const source = await readFile(new URL("../dist/client.js", import.meta.url), "utf8");
  let loaded;
  const window = { __ModuleLoader__: { load: (module) => { loaded = module; } } };
  new Function("window", source)(window);
  const element = (key) => (type, props, elementKey) => ({ type, props, key: elementKey ?? null, kind: key });
  const required = [];
  const client = loaded.factory((name) => {
    required.push(name);
    return { jsx: element("jsx"), jsxs: element("jsxs") };
  });
  return { id: loaded.id, client, required };
}

test("the client bundle loads in the module loader and draws the whole tree in the dock", async () => {
  const { id, client, required } = await loadClient();
  assert.equal(id, "@spinejit/dsh-spinejit");
  assert.deepEqual(required, ["react/jsx-runtime"]);
  assert.deepEqual(client.inject, ["slots", "uiConversation"]);
  const registered = [];
  const rules = [];
  client.apply({
    slots: { inject: (_name, register) => register(), register: (entry, component) => registered.push([entry, component]) },
    uiConversation: { userText: { register: (rule) => { rules.push(rule); return () => {}; } } },
    effect: (execute) => execute(),
  });
  assert.deepEqual(rules, [client.userAnchorRule], "the user-anchor rule is registered");
  assert.deepEqual(registered.map(([entry]) => entry), [{ name: "conversation.input.dock", id: "spinejit", order: 30, registrant: "@spinejit/dsh-spinejit" }]);
  const Dock = registered[0][1];
  assert.equal(Dock({ useProjection: () => undefined }), null);
  assert.equal(Dock({ useProjection: () => ({ cursor: "1", nodes: [node("1", null, null, "Live", "RootEpoch")] }) }), null);
  const keys = [];
  const dock = Dock({ useProjection: (key) => { keys.push(key); return deep; } });
  assert.deepEqual(keys, ["spinejit"]);
  const flat = (part) => typeof part === "string" ? part : Array.isArray(part.props.children) ? part.props.children.map(flat).join("") : flat(part.props.children);
  assert.deepEqual(dock.props.children.map(flat), formatPrettySpineTreeFromNodes(deep.cursor, deep.nodes));
  const current = dock.props.children[4].props.children[1];
  assert.equal(current.props.children, "◉");
  assert.equal(current.props.style.color, "var(--dsw-alias-state-success-primary)");
});
