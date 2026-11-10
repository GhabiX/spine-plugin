import type { NodeSnapshot, SpineProjection } from "../protocol.js";
import {
  spineTreeBranch,
  spineTreeChildPrefix,
  spineTreeBrand,
  spineTreeLabel,
  spineTreeMarker,
  spineTreeMarkerText,
} from "./tree-style.js";

const PRETTY_MAX_VISIBLE_SIBLINGS = 3;
const PRETTY_ACTIVE_PARENT_DEPTH = 3;

export type SpawnState = NonNullable<NodeSnapshot["spawn"]>;
export type NodeStatus = NodeSnapshot["status"];
export type NodeKind = NodeSnapshot["kind"];

export interface DisplayNode {
  nodeId: string;
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus;
  summary: string | null;
  spawn: SpawnState | null;
}

export interface SpineTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function spineBrand(text: string, theme: SpineTheme): string {
  return spineTreeBrand(text, theme);
}

type SiblingItem = { type: "history"; count: number } | { type: "node"; node: DisplayNode };

export function formatNodeId(id: readonly number[]): string {
  return id.join(".");
}

export function displayNodesFromProjection(projection: SpineProjection): DisplayNode[] {
  return projection.nodes.map((node) => ({
    nodeId: formatNodeId(node.id),
    parentId: node.parent === null ? null : formatNodeId(node.parent),
    kind: node.kind,
    status: node.status,
    summary: node.summary,
    spawn: node.spawn,
  }));
}

export function prettySpineTreeHasTasks(projection: SpineProjection): boolean {
  return projection.nodes.some((node) => node.kind === "Task");
}

export function displayTreeSignature(projection: SpineProjection): string {
  const cursor = formatNodeId(projection.cursor);
  const nodes = displayNodesFromProjection(projection).map((node) => [
    node.nodeId,
    node.parentId,
    node.kind,
    node.status,
    node.summary,
    node.spawn,
  ]);
  return JSON.stringify({ cursor, nodes });
}

export function formatPrettySpineTree(projection: SpineProjection): string[] {
  return formatPrettySpineTreeFromNodes(formatNodeId(projection.cursor), displayNodesFromProjection(projection));
}

export function formatPrettySpineTreeFromNodes(activeNodeId: string, nodes: readonly DisplayNode[]): string[] {
  return prettySpineTreeLines(activeNodeId, nodes).map(prettySpineTreeLineText);
}

export function formatThemedPrettySpineTreeFromNodes(
  activeNodeId: string,
  nodes: readonly DisplayNode[],
  theme: SpineTheme,
): string[] {
  return prettySpineTreeLines(activeNodeId, nodes).map((line) => themePrettyLine(line, theme));
}

/** `compactedHint` follows the compacted row: where the front end lets the user look back. */
export function formatThemedPrettySpineTree(
  projection: SpineProjection,
  theme: SpineTheme,
  options: { compactedHint?: string } = {},
): string[] {
  return prettySpineTreeLines(formatNodeId(projection.cursor), displayNodesFromProjection(projection)).map((line) =>
    themePrettyLine(line, theme, options.compactedHint),
  );
}

/**
 * One row of the pretty tree, before it is drawn; `current` marks the cursor's row.
 * `compacted` stands for an empty epoch after a compaction: `count` earlier branches folded away.
 */
export type PrettySpineTreeLine =
  | { type: "header" }
  | { type: "empty" }
  | { type: "compacted"; count: number }
  | { type: "history"; prefix: string; count: number }
  | { type: "node"; prefix: string; marker: string; label: string; current: boolean };

/** The pretty tree's rows for a front end that draws them itself; the first is the header. */
export function prettySpineTreeLines(activeNodeId: string, nodes: readonly DisplayNode[]): PrettySpineTreeLine[] {
  const lines: PrettySpineTreeLine[] = [{ type: "header" }];
  if (nodes.length === 0) {
    lines.push({ type: "empty" });
    return lines;
  }
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (!byId.has(activeNodeId)) {
    lines.push({ type: "empty" });
    return lines;
  }
  const viewport = prettyViewport(activeNodeId, nodes, byId);
  if (viewport.rootNodes.length === 0) {
    const compacted = viewport.earlierBranchCount > 0
      && nodes.some((node) => node.kind === "RootEpoch" && node.status === "Compacted");
    lines.push(compacted ? { type: "compacted", count: viewport.earlierBranchCount } : { type: "empty" });
    return lines;
  }
  appendPrettyNodes(
    lines,
    nodes,
    activeNodeId,
    viewport.rootNodes,
    viewport.activePath,
    "  ",
    viewport.earlierBranchCount,
  );
  return lines;
}

function appendPrettyNodes(
  lines: PrettySpineTreeLine[],
  nodes: readonly DisplayNode[],
  activeNodeId: string,
  level: readonly DisplayNode[],
  activePath: ReadonlySet<string>,
  prefix: string,
  leadingHistoryCount: number,
): void {
  const items = prependHistory(
    prettySiblingItems(visibleNodes(nodes, activeNodeId, level), activePath),
    leadingHistoryCount,
  );
  items.forEach((item, index) => {
    const isLast = index + 1 === items.length;
    const branch = spineTreeBranch(isLast);
    const childPrefix = `${prefix}${spineTreeChildPrefix(isLast)}`;
    if (item.type === "history") {
      lines.push({ type: "history", prefix: `${prefix}${branch}`, count: item.count });
      return;
    }
    const children = childNodes(nodes, item.node.nodeId);
    const current = item.node.nodeId === activeNodeId;
    lines.push({
      type: "node",
      prefix: `${prefix}${branch}`,
      marker: spineTreeMarker(item.node, current, children.length > 0),
      label: spineTreeLabel(item.node, current),
      current,
    });
    if (shouldCollapse(item.node, children.length > 0, activePath)) return;
    appendPrettyNodes(lines, nodes, activeNodeId, children, activePath, childPrefix, 0);
  });
}

function prettyViewport(
  activeNodeId: string,
  nodes: readonly DisplayNode[],
  byId: Map<string, DisplayNode>,
): { rootNodes: DisplayNode[]; earlierBranchCount: number; activePath: Set<string> } {
  const pathNodes = activePathNodes(activeNodeId, byId);
  const activePath = new Set(pathNodes.map((node) => node.nodeId));
  const activeRoot = pathNodes[pathNodes.length - 1];
  if (activeRoot === undefined) {
    return { rootNodes: [], earlierBranchCount: 0, activePath };
  }
  const activeRootNodes = visibleNodes(nodes, activeNodeId, [activeRoot]);
  let earlierBranchCount = 0;
  for (const node of childNodes(nodes, null)) {
    if (node.nodeId === activeRoot.nodeId) continue;
    for (const visible of visibleNodes(nodes, activeNodeId, [node])) {
      if (isCompleted(visible)) earlierBranchCount += 1;
    }
  }
  const visibleActivePath = pathNodes.filter((node) => {
    const children = childNodes(nodes, node.nodeId);
    return !shouldElide(node, children.length > 0, node.nodeId === activeNodeId);
  });
  if (visibleActivePath.length <= PRETTY_ACTIVE_PARENT_DEPTH + 1) {
    return { rootNodes: activeRootNodes, earlierBranchCount, activePath };
  }
  const focusRoot = visibleActivePath[PRETTY_ACTIVE_PARENT_DEPTH];
  if (focusRoot === undefined) {
    return { rootNodes: activeRootNodes, earlierBranchCount, activePath };
  }
  earlierBranchCount += completedOffPathCount(activeRootNodes, activePath);
  for (const ancestor of visibleActivePath.slice(PRETTY_ACTIVE_PARENT_DEPTH + 1)) {
    const children = visibleNodes(nodes, activeNodeId, childNodes(nodes, ancestor.nodeId));
    earlierBranchCount += completedOffPathCount(children, activePath);
  }
  return { rootNodes: [focusRoot], earlierBranchCount, activePath };
}

function prettySiblingItems(nodes: readonly DisplayNode[], activePath: ReadonlySet<string>): SiblingItem[] {
  const items: SiblingItem[] = nodes.map((node) =>
    bucketable(node, activePath) ? { type: "history", count: 1 } : { type: "node", node },
  );
  const activeIndex = nodes.findIndex((node) => activePath.has(node.nodeId));
  const visibleEnd = activeIndex < 0 ? nodes.length : activeIndex + 1;
  if (visibleEnd < nodes.length || nodes.length <= PRETTY_MAX_VISIBLE_SIBLINGS) {
    return mergeHistory(items);
  }
  const visibleStart = Math.max(0, visibleEnd - PRETTY_MAX_VISIBLE_SIBLINGS);
  const folded: SiblingItem[] = [];
  if (visibleStart > 0) {
    folded.push({
      type: "history",
      count: items.slice(0, visibleStart).reduce((sum, item) => sum + (item.type === "history" ? item.count : 1), 0),
    });
  }
  folded.push(...items.slice(visibleStart, visibleEnd));
  return mergeHistory(folded);
}

function visibleNodes(
  nodes: readonly DisplayNode[],
  activeNodeId: string,
  level: readonly DisplayNode[],
): DisplayNode[] {
  const out: DisplayNode[] = [];
  appendVisible(nodes, activeNodeId, level, out);
  return out;
}

function appendVisible(
  nodes: readonly DisplayNode[],
  activeNodeId: string,
  level: readonly DisplayNode[],
  out: DisplayNode[],
): void {
  for (const node of level) {
    const children = childNodes(nodes, node.nodeId);
    if (shouldElide(node, children.length > 0, node.nodeId === activeNodeId)) {
      appendVisible(nodes, activeNodeId, children, out);
    } else {
      out.push(node);
    }
  }
}

function childNodes(nodes: readonly DisplayNode[], parentId: string | null): DisplayNode[] {
  return nodes.filter((node) => node.parentId === parentId);
}

function activePathNodes(activeNodeId: string, byId: Map<string, DisplayNode>): DisplayNode[] {
  const path: DisplayNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(activeNodeId);
  while (current !== undefined) {
    if (!seen.add(current.nodeId)) break;
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

function shouldElide(node: DisplayNode, hasChildren: boolean, active: boolean): boolean {
  return (
    node.kind === "RootEpoch" ||
    (hasChildren && !active && trimmedSummary(node) === null && !isCompleted(node))
  );
}

function shouldCollapse(node: DisplayNode, hasChildren: boolean, activePath: ReadonlySet<string>): boolean {
  return hasChildren && isCompleted(node) && !activePath.has(node.nodeId);
}

function bucketable(node: DisplayNode, activePath: ReadonlySet<string>): boolean {
  return isCompleted(node) && trimmedSummary(node) === null && !activePath.has(node.nodeId);
}

function isCompleted(node: DisplayNode): boolean {
  if (node.kind === "Spawn") return node.spawn !== "pending";
  return node.status === "Closed" || node.status === "Compacted";
}

function completedOffPathCount(nodes: readonly DisplayNode[], activePath: ReadonlySet<string>): number {
  return nodes.filter((node) => !activePath.has(node.nodeId) && isCompleted(node)).length;
}

function prependHistory(items: SiblingItem[], count: number): SiblingItem[] {
  if (count === 0) return items;
  if (items[0]?.type === "history") {
    return [{ type: "history", count: items[0].count + count }, ...items.slice(1)];
  }
  return [{ type: "history", count }, ...items];
}

function mergeHistory(items: SiblingItem[]): SiblingItem[] {
  const merged: SiblingItem[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (item.type === "history" && last?.type === "history") {
      last.count += item.count;
    } else {
      merged.push(item.type === "history" ? { type: "history", count: item.count } : item);
    }
  }
  return merged;
}

function trimmedSummary(node: DisplayNode): string | null {
  const summary = node.summary?.trim();
  return summary === undefined || summary === "" ? null : summary;
}

function historyNoun(count: number): string {
  return count === 1 ? "branch" : "branches";
}

function compactedLabel(count: number): string {
  return `compacted · ${count} earlier ${historyNoun(count)}`;
}

export function prettySpineTreeLineText(line: PrettySpineTreeLine): string {
  switch (line.type) {
    case "header":
      return "• Spine Tree";
    case "empty":
      return "  └ (empty)";
    case "compacted":
      return `  └ ◌ ${compactedLabel(line.count)}`;
    case "history":
      return `${line.prefix}◌ ${line.count} earlier ${historyNoun(line.count)}`;
    case "node":
      return `${line.prefix}${line.marker} ${line.label}`;
  }
}

function themePrettyLine(line: PrettySpineTreeLine, theme: SpineTheme, compactedHint?: string): string {
  switch (line.type) {
    case "header":
      return `${theme.fg("dim", "• ")}${spineBrand("Spine Tree", theme)}`;
    case "empty":
      return `${theme.fg("dim", "  └ ")}${theme.fg("dim", "(empty)")}`;
    case "compacted": {
      const hint = compactedHint === undefined ? "" : `${theme.fg("dim", " · ")}${theme.fg("accent", compactedHint)}`;
      return `${theme.fg("dim", "  └ ◌ ")}${theme.fg("dim", compactedLabel(line.count))}${hint}`;
    }
    case "history": {
      const noun = historyNoun(line.count);
      const label = `${line.count} earlier ${noun}`;
      return `${theme.fg("dim", line.prefix)}${theme.fg("dim", "◌ ")}${theme.fg("dim", label)}`;
    }
    case "node":
      return `${theme.fg("dim", line.prefix)}${spineTreeMarkerText(line.marker, theme)} ${line.label}`;
  }
}

