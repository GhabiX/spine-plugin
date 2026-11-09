// The shown session's Spine tree in DeepSeek Harness's terminal: up to three
// rows above the prompt that always keep the cursor's row, when dsh-tui is
// composed. The header Pi draws is left out; colors are the theme's.
import type { Context } from "@deepseek-ai/cordis";
import { prettySpineTreeLineText, spineTreeMarkerTone, type PrettySpineTreeLine } from "@spinejit/spine-sdk/view";

import type { TreeDisplay } from "./display.js";
import { showsTree, treeWindow } from "./tree.js";

const ROWS = 3;

type CreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

/** What a dsh-tui status view receives: the host's React and its UI kit. */
export interface TreeViewProps {
  React: {
    createElement: CreateElement;
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T;
  };
  ui: { Box: unknown; Text: unknown };
}

/** The part of dsh-tui's status service the tree uses. */
interface TuiStatus {
  registerView(
    descriptor: { key: string; maxRows: 1 | 2 | 3; component: (props: TreeViewProps) => unknown },
    identity?: Context,
  ): (() => void) | undefined;
}

const TONE_COLOR = { brand: "success", error: "error", warning: "warning" } as const;

export function registerTreeView(ctx: Context, display: TreeDisplay): void {
  ctx.inject(["tuiStatus"] as never, ((tuiCtx: Context) => {
    (tuiCtx as unknown as { tuiStatus: TuiStatus }).tuiStatus.registerView(
      { key: "spinejit:tree", maxRows: ROWS, component: (props) => treeRows(props, display) },
      tuiCtx,
    );
  }) as never);
}

export function treeRows({ React, ui }: TreeViewProps, display: TreeDisplay): unknown {
  const tree = React.useSyncExternalStore(display.subscribe, display.shown);
  if (!showsTree(tree)) return null;
  const h = React.createElement;
  return h(ui.Box, { flexDirection: "column" }, ...treeWindow(tree, ROWS).map((line, index) =>
    h(ui.Text, { key: index, wrap: "truncate" }, ...rowParts(line, h, ui.Text))));
}

function rowParts(line: PrettySpineTreeLine, h: CreateElement, Text: unknown): unknown[] {
  if (line.type !== "node") return [h(Text, { dimColor: true }, prettySpineTreeLineText(line))];
  const tone = spineTreeMarkerTone(line.marker);
  const marker = tone === "dim" ? { dimColor: true } : { color: TONE_COLOR[tone], bold: true };
  return [h(Text, { dimColor: true }, line.prefix), h(Text, marker, line.marker), ` ${line.label}`];
}
