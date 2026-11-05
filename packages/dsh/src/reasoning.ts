import { freezeMessage, type Message } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, type Session, type SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionMessageProjection, SessionMessageProjectionContext } from "@deepseek-ai/dsh-session/surface";

// A model output Spine moved behind another prefix (a sampling made with a
// node in view that has since folded, a kept reply) loses its reasoning: what the Spine plan labels
// `WithoutReasoning`. DSH keeps logged messages immutable, so the plugin logs
// the decision and a message projection applies it, the same way for a live
// session, a resumed one and a fork.
//
// Stock DSH 0.2.1 admits only its own message-projection event types; a
// session holding an unknown required event cannot be resumed. The decision
// is therefore an ignorable plugin record: DSH applies a registered
// projection by event type before it skips an unknown ignorable event
// (dsh-session planSurfaceEvent, rc.2 and rc.4), and DSH without this plugin
// resumes the session showing the reasoning again.

export const WITHOUT_REASONING = "plugin:spinejit/without-reasoning";

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    /**
     * Drop the reasoning of the named assistant/message nodes from later
     * model requests: their reasoning blocks and their provider replay state
     * (thinking signatures and the like). Text and tool calls stay.
     */
    "plugin:spinejit/without-reasoning": { seqs: SessionSeq[] };
  }
}

/** The message without its reasoning blocks and provider replay state. */
export function withoutReasoning(message: Message): Message {
  const content = message.content.filter((block) => block.type !== "reasoning");
  const source = { ...message.source } as Record<string, unknown>;
  delete source.replayState;
  return freezeMessage({ ...message, content, source } as unknown as Message);
}

/**
 * Whether the message still carries reasoning the label asks to drop.
 *
 * Gemini's reasoning is not tied to the prefix: Gemini accepts its thought
 * signatures after the prefix changed, and requires them on the function
 * calls of its current turn, where the sampling after a close sits once the
 * node folds. A Gemini output keeps its reasoning. Only the pi-ai adapter's
 * replay state names the API that produced a message.
 */
export function hasReasoning(message: Message): boolean {
  const replayState = (message.source as { replayState?: { response?: { kind?: unknown; api?: unknown } } }).replayState;
  const api = replayState?.response?.kind === "pi-ai" ? replayState.response.api : undefined;
  if (typeof api === "string" && api.startsWith("google-")) return false;
  return message.content.some((block) => block.type === "reasoning") || replayState !== undefined;
}

export const withoutReasoningProjection = {
  type: WITHOUT_REASONING,
  project(event: { data: unknown }, context: SessionMessageProjectionContext) {
    const seqs = (event.data as { seqs?: unknown } | undefined)?.seqs;
    if (!Array.isArray(seqs) || seqs.length === 0) {
      throw new Error(`${WITHOUT_REASONING}: data must name a nonempty seqs array`);
    }
    const nodes = new Set(context.nodes);
    const messages = new Map<SessionSeq, Message>();
    for (const seq of seqs as SessionSeq[]) {
      if (typeof seq !== "number" || messages.has(seq)) throw new Error(`${WITHOUT_REASONING}: bad or duplicate seq ${seq}`);
      if (!nodes.has(seq)) throw new Error(`${WITHOUT_REASONING}: seq ${seq} is not a current surface node`);
      const source = context.events[seq - context.baseSeq];
      if (source?.type !== "assistant/message") {
        throw new Error(`${WITHOUT_REASONING}: seq ${seq} must be an assistant/message`);
      }
      messages.set(seq, withoutReasoning(context.messages.get(seq) ?? source.data.message));
    }
    return messages;
  },
} as unknown as SessionMessageProjection;

/** Log one decision for the plan's labelled sources that still show reasoning. */
export function dropReasoning(session: Session, seqs: readonly SessionSeq[]): void {
  const pending = seqs.filter((seq) => {
    const event = session.eventAt(seq);
    const message = event === undefined ? null : session.deriveEventMessage(event);
    return message !== null && hasReasoning(message);
  });
  if (pending.length > 0) appendPluginRecord(session, WITHOUT_REASONING, { seqs: pending });
}
