/** Shared visual vocabulary for the pinned Spine tree and its navigation view. */
export type SpineTreeStatus = "Live" | "Opened" | "Closed" | "Compacted";
export type SpineTreeKind = "RootEpoch" | "Task" | "Spawn";
export type SpineTreeSpawnOutcome = "completed" | "errored" | "aborted";

export interface SpineTreeStyleNode {
  kind: SpineTreeKind;
  status: SpineTreeStatus;
  summary: string | null;
  spawnOutcome: SpineTreeSpawnOutcome | null;
}

export interface SpineTreeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const SPINE_BRAND = "\x1b[92m";
const SPINE_BRAND_RESET = "\x1b[39m";

/** The pinned tree and the optional navigator deliberately share these colors. */
export function spineTreeBrand(text: string, theme: SpineTreeTheme): string {
  return `${SPINE_BRAND}${theme.bold(text)}${SPINE_BRAND_RESET}`;
}

export function spineTreeMarkerText(marker: string, theme: SpineTreeTheme): string {
  switch (marker) {
    case "◉":
    case "✓":
      return spineTreeBrand(marker, theme);
    case "×":
      return theme.fg("error", theme.bold(marker));
    case "!":
      return theme.fg("warning", theme.bold(marker));
    default:
      return theme.fg("dim", marker);
  }
}

export function spineTreeMarker(
  node: SpineTreeStyleNode,
  active: boolean,
  hasChildren: boolean,
  expanded = true,
): string {
  if (active) return "◉";
  // Root epochs are structural containers. The pinned tree hides them; the
  // browser keeps them as a navigation anchor and uses the neutral marker.
  if (node.kind === "RootEpoch") return "◌";
  if (node.spawnOutcome === "completed") return "✓";
  if (node.spawnOutcome === "errored") return "×";
  if (node.spawnOutcome === "aborted") return "!";
  // A birth whose child has not arrived yet is still running.
  if (node.kind === "Spawn") return "◐";
  if (node.status === "Live") return "◉";
  if (node.status === "Closed") return "✓";
  if (node.status === "Compacted") return "◌";
  if (node.status === "Opened" && hasChildren) return expanded ? "▾" : "▸";
  return "◌";
}

export function spineTreeLabel(node: SpineTreeStyleNode, active: boolean): string {
  const summary = node.summary?.trim();
  if (summary) return summary;
  if (active || node.status === "Live") return "Current task";
  if (node.status === "Opened") return "Task";
  if (node.status === "Closed") return "Completed task";
  return "Previous task";
}

export function spineTreeBranch(isLast: boolean): string {
  return isLast ? "└ " : "├ ";
}

export function spineTreeChildPrefix(isLast: boolean): string {
  return isLast ? "  " : "│ ";
}
