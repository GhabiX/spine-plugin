// What the host and the browser share about the Spine tree they show: its
// shape, its names in the session, and the rows each front end draws.
import type { SpineProjection } from "@spinejit/spine-sdk";
import {
  displayNodesFromProjection,
  formatNodeId,
  prettySpineTreeLines,
  type DisplayNode,
  type PrettySpineTreeLine,
} from "@spinejit/spine-sdk/view";

/** The plugin record that carries a session's tree, written when what it shows changes. */
export const TREE_RECORD = "plugin:spinejit/tree";

/** The session projection clients read the latest tree under. */
export const TREE_PROJECTION = "spinejit";

/** What the tree shows: the cursor and the nodes the pretty tree is drawn from. */
export interface SpineTree {
  cursor: string;
  nodes: DisplayNode[];
}

export function spineTreeOf(projection: SpineProjection): SpineTree {
  return { cursor: formatNodeId(projection.cursor), nodes: displayNodesFromProjection(projection) };
}

/** A tree is shown once the agent has opened a task, as in Pi. */
export function showsTree(tree: SpineTree | null | undefined): tree is SpineTree {
  return tree?.nodes.some((node) => node.kind === "Task") === true;
}

/**
 * The pretty tree's rows without its header, cut to at most `rows` rows that
 * keep the cursor's row: one row above it where there is one, the rest below.
 * At the root epoch, which the pretty tree never draws, the newest rows.
 */
export function treeWindow(tree: SpineTree, rows: number): PrettySpineTreeLine[] {
  const lines = prettySpineTreeLines(tree.cursor, tree.nodes).slice(1);
  if (lines.length <= rows) return lines;
  const current = lines.findIndex((line) => line.type === "node" && line.current);
  const start = current < 0 ? lines.length - rows : Math.min(Math.max(0, current - 1), lines.length - rows);
  return lines.slice(start, start + rows);
}
