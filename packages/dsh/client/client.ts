// The browser half: the Spine tree in the conversation's input dock, from the
// session's "spinejit" projection that the host folds from the tree records;
// and the user's messages shown without the `[U<n>]` the model reads in front
// of them. Vite (vite.config.ts) bundles this entry and the dock UI into
// dist/client.js, the client module the DSH web client loads; tsconfig.client.json
// emits the matching types into dist/client.
import { SpineDock } from "./spine-dock.js";

export { SpineDock };
export type { SpineDockProps } from "./spine-dock.js";

/** The part of the client's slot service the entry uses. */
interface Slots {
  inject(name: "conversation.input.dock", register: () => unknown): unknown;
  register(
    entry: { name: "conversation.input.dock"; id: string; order: number; registrant: string },
    component: typeof SpineDock,
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
