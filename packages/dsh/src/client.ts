// The browser half: the Spine tree in the conversation's input dock, drawn
// whole as Pi draws it, from the session's "spinejit" projection that the host
// folds from the tree records. scripts/build-client.mjs bundles it into
// dist/client.js, the client module the DSH web client loads.
import { jsx, jsxs } from "react/jsx-runtime";
import {
  prettySpineTreeLines,
  prettySpineTreeLineText,
  spineTreeMarkerTone,
  type PrettySpineTreeLine,
  type SpineTreeMarkerTone,
} from "@spinejit/spine-sdk/view";

import { showsTree, TREE_PROJECTION, type SpineTree } from "./tree.js";

type Style = Record<string, string | number>;

/** The dock seat's props the entry reads. */
export interface SpineDockProps {
  useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
}

/** The part of the client's slot service the entry uses. */
interface Slots {
  inject(name: "conversation.input.dock", register: () => unknown): unknown;
  register(
    entry: { name: "conversation.input.dock"; id: string; order: number; registrant: string },
    component: (props: SpineDockProps) => unknown,
  ): unknown;
}

export const inject = ["slots"];

export function apply(ctx: { slots: Slots }): void {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // After the official entries: todo 0, goal 10, activity 15, queue 20.
    id: "spinejit",
    order: 30,
    registrant: "@spinejit/dsh-spinejit",
  }, SpineDock));
}

// Sized to the composer card, as the official dock rows are.
const BLOCK: Style = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: "var(--dsh-composer-card-max-width)",
  margin: "0 auto",
  padding: "4px 16px 0",
  fontFamily: "var(--dsw-font-mono, monospace)",
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--dsw-alias-label-secondary)",
};
const ROW: Style = { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" };
const DIM: Style = { color: "var(--dsw-alias-label-tertiary)" };
const TONE: Record<SpineTreeMarkerTone, Style> = {
  brand: { color: "var(--dsw-alias-state-success-primary)", fontWeight: 600 },
  error: { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 },
  warning: { color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 },
  dim: DIM,
};

/** Hook-free but for `useProjection`, so the dock can also call it as a plain function. */
export function SpineDock({ useProjection }: SpineDockProps): unknown {
  const tree = useProjection(TREE_PROJECTION);
  if (!showsTree(tree)) return null;
  return jsx("div", {
    style: BLOCK,
    children: prettySpineTreeLines(tree.cursor, tree.nodes).map((line, index) =>
      jsxs("div", { style: ROW, children: rowParts(line) }, index)),
  });
}

function rowParts(line: PrettySpineTreeLine): unknown[] {
  switch (line.type) {
    case "header":
      return [span(DIM, "• "), span(TONE.brand, "Spine Tree")];
    case "node":
      return [span(DIM, line.prefix), span(TONE[spineTreeMarkerTone(line.marker)], line.marker), ` ${line.label}`];
    default:
      return [span(DIM, prettySpineTreeLineText(line))];
  }
}

function span(style: Style, text: string): unknown {
  return jsx("span", { style, children: text });
}
