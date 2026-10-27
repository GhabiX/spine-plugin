import {
  createDeveloperMessage,
  createUserMessage,
  freezeMessage,
  type ContentBlock,
  type DeveloperMessage,
  type Message,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SourceCharacter } from "@spinejit/spine-sdk";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** Context this plugin writes: node descriptors, memory, births and empty slots. */
    spine: { kind: "spine" };
  }
}

/**
 * How one surface event takes part in Spine context.
 * - host: DSH maintains it each step (system prompt, tool registry changes,
 *   runtime context). It is not a source and stays where it is.
 * - spine: written by this plugin.
 * - source: conversation the Spine core observes.
 */
export type SurfaceRole = "host" | "spine" | "source";

export class SpineDshError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpineDshError";
  }
}

/** The message a surface event derives, before any later replacement. */
export function eventMessage(event: SessionEvent): Message {
  switch (event.type) {
    case "user/message":
      return event.data;
    case "system/message":
    case "developer/message":
    case "assistant/message":
    case "tool/result":
      return event.data.message;
    default:
      throw new SpineDshError(`session event ${event.seq} (${event.type}) carries no message`);
  }
}

export function surfaceRole(event: SessionEvent): SurfaceRole {
  const message = eventMessage(event);
  const kind: string = message.source.kind;
  if (kind === "spine") return "spine";
  if (message.role === "system" || message.role === "developer") return "host";
  if (message.role === "user" && kind === "runtime-context") return "host";
  return "source";
}

/** A message the user wrote. The Spine core numbers these as `[U<n>]`. */
export function isUserSource(event: SessionEvent): boolean {
  return event.type === "user/message" && event.data.source.kind === "user";
}

/** What the Spine core observes for one source event; the boundary is the event seq. */
export function sourceCharacter(event: SessionEvent): SourceCharacter {
  const boundary = event.seq;
  if (event.type === "tool/result") return { type: "opaque", boundary };
  const message = eventMessage(event);
  const content = contentText(message.content);
  if (event.type === "assistant/message") {
    return { type: "message", boundary, role: isReply(event) ? "reply" : "assistant", content };
  }
  if (isUserSource(event)) {
    return { type: "message", boundary, role: "user", content: content.replace(ANCHOR, "") };
  }
  if (message.role === "user") {
    return { type: "message", boundary, role: "contextual_user", content };
  }
  throw new SpineDshError(`session event ${event.seq} (${event.type}) is not a Spine source`);
}

const ANCHOR = /^\[U(\d+)\]\n/;

/** The user message with `[U<anchor>]` in front of its first text, as the Spine plan shows it. */
export function anchored(message: UserMessage, anchor: number): UserMessage {
  const prefix = `[U${anchor}]\n`;
  const content = [...message.content];
  const first = content.findIndex((block) => block.type === "text");
  if (first < 0) {
    content.unshift({ type: "text", text: prefix });
  } else {
    const block = content[first] as Extract<ContentBlock, { type: "text" }>;
    content[first] = { type: "text", text: prefix + block.text };
  }
  return freezeMessage({ ...message, content });
}

/** The `[U<n>]` a logged message starts with, or null. */
export function anchorOf(message: Message): number | null {
  const first = message.content.find((block) => block.type === "text");
  const match = first === undefined ? null : ANCHOR.exec((first as { text: string }).text);
  return match === null ? null : Number(match[1]);
}

/** An empty developer message: on the surface, but derives no model message. */
export function emptySlot(): DeveloperMessage {
  return createDeveloperMessage({ content: [], source: { kind: "spine" } });
}

/** A Spine item (node descriptor, memory, birth) as a model-visible user message. */
export function spineMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "spine" } });
}

/** The visible text of a message this plugin wrote; null for an empty slot. */
export function spineText(message: Message): string | null {
  return message.content.length === 0 ? null : contentText(message.content);
}

/** The agent's reply to the user: complete, with text, and calling no tool. */
function isReply(event: Extract<SessionEvent, { type: "assistant/message" }>): boolean {
  const content = event.data.message.content;
  return event.data.interrupted !== true &&
    content.every((block) => block.type !== "tool-call") &&
    content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function contentText(content: readonly ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "image") text += "<image>";
  }
  return text;
}
