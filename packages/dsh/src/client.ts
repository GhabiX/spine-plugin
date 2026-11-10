// The browser half: the Spine tree in the conversation's input dock, drawn
// whole as Pi draws it, from the session's "spinejit" projection that the host
// folds from the tree records; and the user's messages shown without the
// `[U<n>]` the model reads in front of them. scripts/build-client.mjs bundles
// it into dist/client.js, the client module the DSH web client loads.
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

/** The part of the Conversation plugin's user-text registry the entry uses. */
interface UserTextRegistry {
  register(rule: typeof userAnchorRule): () => void;
}

export const inject = ["slots", "uiConversation"];

export function apply(ctx: {
  slots: Slots;
  uiConversation: { userText: UserTextRegistry };
  effect(execute: () => () => void, label?: string): unknown;
}): void {
  ctx.effect(() => ctx.uiConversation.userText.register(userAnchorRule), "spinejit: user anchor");
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // After the official entries: todo 0, goal 10, activity 15, queue 20.
    id: "spinejit",
    order: 30,
    registrant: "@spinejit/dsh-spinejit",
  }, SpineDock));
}

// A user message's text starts with its `[U<n>]`: the model reads the number,
// so it is in the logged message (DSH builds a request from the log, with no
// point between logging a message and sending it). Pi shows the user the
// message without it; so does this rule, in the bubble only. The text, its
// copy and the log keep it.
const USER_ANCHOR = /^\[U\d+\]\n/;

/** Hides the `[U<n>]` line a user message starts with; the Conversation plugin applies it to every user bubble. */
export const userAnchorRule = {
  id: "spinejit.user-anchor",
  // Before the official whitespace rules (1000, 1010); only same-start candidates compete.
  order: 900,
  match(text: string, from: number) {
    if (from !== 0) return undefined;
    const anchor = USER_ANCHOR.exec(text);
    if (anchor === null) return undefined;
    return { id: "text" as const, start: 0, end: anchor[0].length, data: { text: anchor[0], display: "" } };
  },
};

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
