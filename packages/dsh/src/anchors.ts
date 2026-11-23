import { isDeepStrictEqual } from "node:util";
import { freezeMessage, type ContentBlock, type Message, type UserMessage } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, type Session, type SessionEvent, type SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionMessageProjection, SessionMessageProjectionContext } from "@deepseek-ai/dsh-session/surface";

// The Spine core numbers the messages the user wrote `[U<n>]`, and the model
// must see the number. The user must not: DSH clients draw a user message from
// its logged event, not from what the model is sent. So the logged message
// stays as the user wrote it; the plugin logs each number as it enters a step,
// and a message projection puts it in front of the message the model reads,
// the same way for a live session, a resumed one and a fork.
//
// As for WithoutReasoning, the record is an ignorable plugin record: DSH
// without this plugin skips it and resumes the session without the numbers.
//
// Sessions logged by dsh-spinejit 0.1.1 and earlier carry the number in the
// message text itself. During replay, sampling markers distinguish these
// numbered messages from new, as-yet-unsampled user input.

export const USER_ANCHORS = "plugin:spinejit/user-anchors";

/** One user message's number: the n-th message the user wrote in the log. */
export interface UserAnchor {
  seq: SessionSeq;
  anchor: number;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    /**
     * Show each named user/message to the model with `[U<anchor>]` in front of
     * its first text. The logged message, which clients show, is unchanged.
     */
    "plugin:spinejit/user-anchors": { anchors: UserAnchor[] };
  }
}

const ANCHOR = /^\[U(\d+)\]\n/;

export function anchorPrefix(anchor: number): string {
  return `[U${anchor}]\n`;
}

/** The user message with `[U<anchor>]` in front of its first text, as the Spine plan shows it. */
export function anchored<M extends Message>(message: M, anchor: number): M {
  const prefix = anchorPrefix(anchor);
  const content = [...message.content] as ContentBlock[];
  const first = content.findIndex((block) => block.type === "text");
  if (first < 0) {
    content.unshift({ type: "text", text: prefix });
  } else {
    const block = content[first] as Extract<ContentBlock, { type: "text" }>;
    content[first] = { type: "text", text: prefix + block.text };
  }
  return freezeMessage({ ...message, content } as Message) as M;
}

/** The first text block of a message. Anchors are prepended to this block. */
export function firstText(message: Message): string | undefined {
  return message.content.find((block) => block.type === "text")?.text;
}

/** The text without the `[U<n>]` it starts with. */
export function withoutAnchor(text: string): string {
  return text.replace(ANCHOR, "");
}

/** Confirm an inline anchor against the last queued copy of this message. */
export function hasRepairedInlineAnchor(
  events: ReadonlyMap<number, SessionEvent>, seq: SessionSeq, message: UserMessage, anchor: number,
): boolean {
  for (let previous = Number(seq) - 1; previous >= 0; previous -= 1) {
    const event = events.get(previous);
    if (event?.type !== "agent/inbox/spliced") continue;
    for (let index = event.data.inserted.length - 1; index >= 0; index -= 1) {
      const original = event.data.inserted[index]!;
      if (original.id === message.id && original.source.kind === "user") {
        return isDeepStrictEqual(anchored(original, anchor).content, message.content);
      }
    }
  }
  return false;
}

export const userAnchorsProjection = {
  type: USER_ANCHORS,
  project(event: { data: unknown }, context: SessionMessageProjectionContext) {
    const anchors = (event.data as { anchors?: unknown } | undefined)?.anchors;
    if (!Array.isArray(anchors) || anchors.length === 0) {
      throw new Error(`${USER_ANCHORS}: data must name a nonempty anchors array`);
    }
    const nodes = new Set(context.nodes);
    const messages = new Map<SessionSeq, Message>();
    for (const entry of anchors as UserAnchor[]) {
      const { seq, anchor } = entry ?? {};
      if (typeof seq !== "number" || messages.has(seq)) throw new Error(`${USER_ANCHORS}: bad or duplicate seq ${seq}`);
      if (!Number.isSafeInteger(anchor) || anchor < 1) throw new Error(`${USER_ANCHORS}: bad anchor ${anchor} for seq ${seq}`);
      if (!nodes.has(seq)) throw new Error(`${USER_ANCHORS}: seq ${seq} is not a current surface node`);
      const source = context.events[seq - context.baseSeq];
      if (source?.type !== "user/message" || source.data.source.kind !== "user") {
        throw new Error(`${USER_ANCHORS}: seq ${seq} must be a user/message the user wrote`);
      }
      messages.set(seq, anchored(context.messages.get(seq) ?? source.data, anchor));
    }
    return messages;
  },
} as unknown as SessionMessageProjection;

/** Log the numbers of the user messages that have none yet. */
export function logAnchors(session: Session, anchors: readonly UserAnchor[]): void {
  if (anchors.length > 0) appendPluginRecord(session, USER_ANCHORS, { anchors: [...anchors] });
}
