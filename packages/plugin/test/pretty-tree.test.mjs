import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPrettySpineTreeFromNodes,
  formatThemedPrettySpineTreeFromNodes,
} from "../dist/pi/pretty-tree.js";

function node(nodeId, parentId, summary, status, kind = "Task", outcome = null) {
  return { nodeId, parentId, kind, status, summary, spawn: outcome === null ? null : { arrived: outcome } };
}

function rootEpoch(nodeId, summary, status) {
  return node(nodeId, null, summary, status, "RootEpoch");
}

test("pretty tree folds the active path and earlier completed branches", () => {
  const lines = formatPrettySpineTreeFromNodes("2.1", [
    node("1", null, "earlier work", "Closed"),
    node("2", null, "current scope", "Opened"),
    node("2.1", "2", "focused task", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    [
      "• Spine Tree",
      "  ├ ◌ 1 earlier branch",
      "  └ ▾ current scope",
      "    └ ◉ focused task",
    ].join("\n"),
  );
});

test("pretty tree folds older siblings and elides empty structural nodes", () => {
  const lines = formatPrettySpineTreeFromNodes("3.3", [
    node("1", null, "old root 1", "Closed"),
    node("2", null, "old root 2", "Closed"),
    node("3", null, null, "Opened"),
    node("3.1", "3", "child 1", "Closed"),
    node("3.2", "3", "child 2", "Closed"),
    node("3.3", "3", "active child", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    [
      "• Spine Tree",
      "  ├ ◌ 2 earlier branches",
      "  ├ ✓ child 1",
      "  ├ ✓ child 2",
      "  └ ◉ active child",
    ].join("\n"),
  );
  assert.equal(lines.some((line) => line.includes("old root")), false);
});

test("pretty tree merges viewport history with leading sibling buckets", () => {
  const lines = formatPrettySpineTreeFromNodes("4.6", [
    node("1", null, "old root 1", "Closed"),
    node("2", null, "old root 2", "Closed"),
    node("3", null, "old root 3", "Closed"),
    rootEpoch("4", "root", "Opened"),
    node("4.1", "4", null, "Closed"),
    node("4.2", "4", null, "Closed"),
    node("4.3", "4", null, "Closed"),
    node("4.4", "4", null, "Closed"),
    node("4.5", "4", null, "Closed"),
    node("4.6", "4", "active task", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    ["• Spine Tree", "  ├ ◌ 8 earlier branches", "  └ ◉ active task"].join("\n"),
  );
});

test("pretty tree collapses completed parent subtrees after root epoch promotion", () => {
  const lines = formatPrettySpineTreeFromNodes("2.1", [
    rootEpoch("1", "root", "Compacted"),
    node("1.1", "1", "compacted parent", "Compacted"),
    node("1.1.1", "1.1", "hidden compacted child", "Closed"),
    node("1.2", "1", "closed parent", "Closed"),
    node("1.2.1", "1.2", "hidden closed child", "Closed"),
    rootEpoch("2", "root", "Opened"),
    node("2.1", "2", "active task", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    ["• Spine Tree", "  ├ ◌ 2 earlier branches", "  └ ◉ active task"].join("\n"),
  );
  assert.equal(lines.join("\n").includes("hidden compacted child"), false);
  assert.equal(lines.join("\n").includes("hidden closed child"), false);
});

test("pretty tree hides root epochs and promotes their tasks", () => {
  const lines = formatPrettySpineTreeFromNodes("3.2", [
    rootEpoch("1", "root", "Closed"),
    node("1.1", "1", "first task", "Closed"),
    rootEpoch("2", "root", "Closed"),
    node("2.1", "2", "second task", "Closed"),
    rootEpoch("3", "root", "Opened"),
    node("3.1", "3", "current scope", "Opened"),
    node("3.2", "3.1", "active task", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    [
      "• Spine Tree",
      "  ├ ◌ 2 earlier branches",
      "  └ ▾ current scope",
      "    └ ◉ active task",
    ].join("\n"),
  );
  assert.equal(lines.join("\n").includes("root"), false);
});

test("pretty tree focuses a deep active path and counts hidden history", () => {
  const lines = formatPrettySpineTreeFromNodes("4.1.1.1.1.1", [
    node("1", null, "older work", "Closed"),
    node("2", null, "Implement and verify a loadable Pi Spine extension", "Compacted"),
    node("3", null, "Implement the DeepSeek Harness required-event registry", "Compacted"),
    node("4", null, "Complete DSH host validation and plugin integration", "Opened"),
    node("4.0", "4", "Review the current execution tree", "Closed"),
    node("4.1", "4", "Complete DSH seam validation and diff review", "Opened"),
    node("4.1.0", "4.1", "Refresh and verify the DSH event graph", "Closed"),
    node("4.1.0.1", "4.1", "Synchronize generated graph records", "Closed"),
    node("4.1.1", "4.1", "Run the full DSH type gate and review the diff", "Opened"),
    node("4.1.1.0", "4.1.1", "Review DSH host semantics and failure boundaries", "Closed"),
    node("4.1.1.0.1", "4.1.1", "Record DSH validation results", "Closed"),
    node("4.1.1.1", "4.1.1", "Bind the unified plugin to the DSH host API", "Opened"),
    node("4.1.1.1.0", "4.1.1.1", "Define the minimal DSH API binding contract", "Closed"),
    node("4.1.1.1.1", "4.1.1.1", "Implement and test DSH lifecycle bindings", "Opened"),
    node("4.1.1.1.1.1", "4.1.1.1.1", "Add runtime integration coverage for the DSH contract", "Live"),
  ]);
  assert.equal(
    lines.join("\n"),
    [
      "• Spine Tree",
      "  ├ ◌ 6 earlier branches",
      "  └ ▾ Run the full DSH type gate and review the diff",
      "    ├ ✓ Review DSH host semantics and failure boundaries",
      "    ├ ✓ Record DSH validation results",
      "    └ ▾ Bind the unified plugin to the DSH host API",
      "      ├ ✓ Define the minimal DSH API binding contract",
      "      └ ▾ Implement and test DSH lifecycle bindings",
      "        └ ◉ Add runtime integration coverage for the DSH contract",
    ].join("\n"),
  );
});

test("pretty tree marks spawn outcomes instead of generic closed status", () => {
  const lines = formatPrettySpineTreeFromNodes("1", [
    node("1", null, "parent", "Opened"),
    node("1.1", "1", "child a", "Closed", "Task", "completed"),
    node("1.2", "1", "child b", "Closed", "Task", "errored"),
    node("1.3", "1", "child c", "Closed", "Task", "aborted"),
  ]);
  assert.equal(
    lines.join("\n"),
    [
      "• Spine Tree",
      "  └ ◉ parent",
      "    ├ ✓ child a",
      "    ├ × child b",
      "    └ ! child c",
    ].join("\n"),
  );
});

test("root-epoch-only snapshots render the empty pretty tree", () => {
  const lines = formatPrettySpineTreeFromNodes("1", [rootEpoch("1", "root", "Live")]);
  assert.equal(lines.join("\n"), ["• Spine Tree", "  └ (empty)"].join("\n"));
});

test("themed pretty tree keeps history dim and current node on success", () => {
  const theme = {
    fg(color, text) {
      return `[${color}]${text}`;
    },
    bold(text) {
      return text;
    },
  };
  const lines = formatThemedPrettySpineTreeFromNodes(
    "2.1",
    [
      node("1", null, "earlier work", "Closed"),
      node("2", null, "current scope", "Opened"),
      node("2.1", "2", "focused task", "Live"),
    ],
    theme,
  );
  assert.match(lines[0], /\x1b\[92mSpine Tree\x1b\[39m/);
  assert.match(lines[1], /\[dim\]1 earlier branch/);
  assert.equal(lines[1].includes("[success]"), false);
  assert.match(lines[2], /\[dim\]▾/);
  assert.match(lines[3], /\x1b\[92m◉\x1b\[39m/);
});
