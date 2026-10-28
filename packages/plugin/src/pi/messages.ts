import type {
  ContextItem,
  ContextPlanCell,
  EpochOrdinalId,
  SourceCharacter,
  SpawnArrival,
} from "@spinejit/spine-sdk";
import {
  spineArrivalText,
  spineBirthText,
  spineMemoryText,
  spineNodeText,
  type PublishedContext,
} from "@spinejit/spine-sdk/host";
import { PI_ARRIVAL_MESSAGE_TYPE, type PiArrivalDetails } from "./protocol.js";

interface PiTextContent {
  type: "text";
  text: string;
}

interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

export const PI_SPINE_NODE_MESSAGE_TYPE = "spine.node";
export const PI_SPINE_MEMORY_MESSAGE_TYPE = "spine.memory";
export const PI_SPINE_BIRTH_MESSAGE_TYPE = "spine.birth";

export interface PiSpineProjectionDetails {
  schema: "spine.pi.projection/v1";
  kind: "node" | "memory" | "birth";
  nodeId: string;
  status?: string;
  renderer: "xml";
}

export type PiAgentMessage =
  | {
      role: "system";
      content: string | PiTextContent[];
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      role: "user";
      content: string | Array<PiTextContent | PiImageContent>;
      timestamp: number;
    }
  | {
      role: "assistant";
      content: Array<PiTextContent | PiThinkingContent | PiToolCall>;
      [key: string]: unknown;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<PiTextContent | PiImageContent>;
      isError: boolean;
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      role: "custom";
      customType: string;
      content: string | Array<PiTextContent | PiImageContent>;
      display: boolean;
      timestamp: number;
      details?: unknown;
    }
  | {
      role: "bashExecution";
      command: string;
      output: string;
      exitCode: number | undefined;
      cancelled: boolean;
      truncated: boolean;
      timestamp: number;
      excludeFromContext?: boolean;
      fullOutputPath?: string;
    }
  | { role: "branchSummary"; summary: string; fromId: string; timestamp: number }
  | { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number };

interface TextPart {
  type: "text";
  text: string;
}

export interface PiSourceObservation {
  character: SourceCharacter;
  message: PiAgentMessage;
}

export class PiContextMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiContextMaterializationError";
  }
}

/** Pi owns prompt sections and tool declarations. They are not conversation sources. */
export function isPiHostSystemMessage(message: { role: string }): boolean {
  return message.role === "system";
}

export function sourceObservation(
  message: PiAgentMessage,
  boundary: number,
): PiSourceObservation {
  if (message.role === "toolResult") {
    return { character: { type: "opaque", boundary }, message };
  }
  const arrival = arrivalOf(message);
  if (arrival !== null) {
    return { character: { type: "arrival", boundary, arrival }, message };
  }
  const role = isReply(message) ? "reply" : sourceRole(message);
  return {
    character: {
      type: "message",
      boundary,
      role,
      content: sourceCharacterContent(message),
    },
    message,
  };
}

/** The typed arrival a Spine arrival message carries, or null for any other message. */
export function arrivalOf(message: PiAgentMessage): SpawnArrival | null {
  if (message.role !== "custom" || message.customType !== PI_ARRIVAL_MESSAGE_TYPE) return null;
  const details = message.details as Partial<PiArrivalDetails> | undefined;
  if (details?.schema !== "spine.pi.arrival/v1" || details.arrival === undefined) {
    throw new PiContextMaterializationError("Spine arrival message has no typed arrival");
  }
  return details.arrival;
}

/** The model-visible text of an arrival; the typed value travels in details. */
export function arrivalMessage(arrival: SpawnArrival): Extract<PiAgentMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: PI_ARRIVAL_MESSAGE_TYPE,
    content: spineArrivalText(arrival),
    display: true,
    timestamp: Date.now(),
    details: { schema: "spine.pi.arrival/v1", arrival } satisfies PiArrivalDetails,
  };
}

/** The agent's reply to the user: it ended with stop, has text, and calls no tool. */
function isReply(message: PiAgentMessage): boolean {
  return message.role === "assistant" &&
    message.stopReason === "stop" &&
    message.content.every((part) => part.type !== "toolCall") &&
    message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
}

function sourceCharacterContent(message: PiAgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push("<image>");
    }
  }
  return parts.join("");
}

interface BoundPiSource {
  message: PiAgentMessage;
  entryId: string | null;
}

export class PiSourceBindings {
  readonly #messages = new Map<string, BoundPiSource>();

  bind(sourceId: EpochOrdinalId, message: PiAgentMessage, entryId: string | null = null): void {
    const key = sourceIdKey(sourceId);
    if (this.#messages.has(key)) {
      throw new PiContextMaterializationError(`duplicate Pi source binding ${key}`);
    }
    this.#messages.set(key, { message: structuredClone(message), entryId });
  }

  resolve(sourceId: EpochOrdinalId): PiAgentMessage {
    return structuredClone(this.#require(sourceId).message);
  }

  entryId(sourceId: EpochOrdinalId): string | null {
    return this.#require(sourceId).entryId;
  }

  /** Fill entry ids that were not known when the source was observed. Length must match. */
  assignEntryIds(entryIds: readonly (string | null)[]): void {
    const records = [...this.#messages.values()];
    if (records.length !== entryIds.length) return;
    for (let index = 0; index < records.length; index += 1) {
      const entryId = entryIds[index];
      const record = records[index]!;
      if (record.entryId === null && typeof entryId === "string" && entryId.length > 0) {
        record.entryId = entryId;
      }
    }
  }

  clear(): void {
    this.#messages.clear();
  }

  #require(sourceId: EpochOrdinalId): BoundPiSource {
    const record = this.#messages.get(sourceIdKey(sourceId));
    if (record === undefined) {
      throw new PiContextMaterializationError(
        `missing Pi message for source ${sourceIdKey(sourceId)}`,
      );
    }
    return record;
  }
}

export interface PiContextMaterializationOptions {
  nodePrompt?: string;
  /** Model-visible messages for a session entry. An empty list omits that entry. */
  projectedMessages?: ReadonlyMap<string, readonly PiAgentMessage[]>;
}

export function materializePiContext(
  context: PublishedContext,
  bindings: PiSourceBindings,
  options: PiContextMaterializationOptions = {},
): PiAgentMessage[] {
  const plan = context.contextPlan;
  if (plan === null) {
    return [];
  }

  const messages: PiAgentMessage[] = [];
  const projectedIndex = new Map<string, number>();
  for (const cell of plan.cells) {
    if (cell.type === "source") {
      const entryId = bindings.entryId(cell.source_id);
      const projected = entryId === null ? undefined : options.projectedMessages?.get(entryId);
      let message: PiAgentMessage;
      if (projected !== undefined) {
        const index = projectedIndex.get(entryId!) ?? 0;
        projectedIndex.set(entryId!, index + 1);
        const replacement = projected[index];
        if (replacement === undefined) continue;
        message = structuredClone(replacement);
      } else {
        message = bindings.resolve(cell.source_id);
      }
      for (const label of cell.labels) {
        message = prependUserAnchor(message, label.UserAnchor);
      }
      messages.push(message);
      continue;
    }
    messages.push(materializeProjection(cell, options.nodePrompt ?? ""));
  }
  return messages;
}

function materializeProjection(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
  nodePrompt: string,
): PiAgentMessage {
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const { node_id: nodeId, summary, status } = item.SyntheticNode;
    return spineProjectionMessage(
      PI_SPINE_NODE_MESSAGE_TYPE,
      spineNodeText(nodeId, summary, status, nodePrompt),
      {
        schema: "spine.pi.projection/v1",
        kind: "node",
        nodeId: nodeId.join("."),
        status: status.toLowerCase(),
        renderer: "xml",
      },
    );
  }
  if ("MemorySlot" in item) {
    const slot = item.MemorySlot;
    if ("Summary" in slot) {
      const nodeId = slot.Summary.owner_node.join(".");
      return spineProjectionMessage(
        PI_SPINE_MEMORY_MESSAGE_TYPE,
        spineMemoryText(slot.Summary.owner_node, slot.Summary.body),
        {
          schema: "spine.pi.projection/v1",
          kind: "memory",
          nodeId,
          renderer: "xml",
        },
      );
    }
    if ("Birth" in slot) {
      const { owner_node: owner, task } = slot.Birth;
      const nodeId = owner.join(".");
      return spineProjectionMessage(
        PI_SPINE_BIRTH_MESSAGE_TYPE,
        spineBirthText(owner, task),
        {
          schema: "spine.pi.projection/v1",
          kind: "birth",
          nodeId,
          renderer: "xml",
        },
      );
    }
  }
  throw unsupportedProjection(item);
}

export function isPiSpineProjection(
  message: PiAgentMessage,
  customType?: string,
): message is Extract<PiAgentMessage, { role: "custom" }> {
  if (message.role !== "custom") return false;
  if (customType !== undefined && message.customType !== customType) return false;
  const details = message.details;
  return details !== null
    && typeof details === "object"
    && (details as { schema?: unknown }).schema === "spine.pi.projection/v1";
}

function unsupportedProjection(item: ContextItem): PiContextMaterializationError {
  return new PiContextMaterializationError(
    `Pi cannot materialize Spine projection item ${Object.keys(item)[0] ?? "unknown"}`,
  );
}

function prependUserAnchor(message: PiAgentMessage, anchor: number): PiAgentMessage {
  const copy = structuredClone(message);
  if (sourceRole(copy) !== "user") {
    throw new PiContextMaterializationError(`Spine user anchor U${anchor} targets a non-user message`);
  }

  if (copy.role === "user" || copy.role === "custom") {
    if (typeof copy.content === "string") {
      copy.content = `[U${anchor}]\n${copy.content}`;
      return copy;
    }
    const firstText = copy.content.find((part): part is TextPart => part.type === "text");
    if (firstText !== undefined) {
      firstText.text = `[U${anchor}]\n${firstText.text}`;
    } else {
      copy.content.unshift({ type: "text", text: `[U${anchor}]\n` });
    }
    return copy;
  }

  if (copy.role === "bashExecution") {
    throw new PiContextMaterializationError(
      `Spine user anchor U${anchor} cannot preserve Pi bashExecution identity`,
    );
  }
  if (copy.role === "branchSummary" || copy.role === "compactionSummary") {
    throw new PiContextMaterializationError(
      `Spine user anchor U${anchor} cannot target Pi native summary messages`,
    );
  }
  throw new PiContextMaterializationError(`unknown Pi user message for anchor U${anchor}`);
}

function sourceRole(message: PiAgentMessage): "user" | "contextual_user" | "assistant" {
  switch (message.role) {
    case "system":
      throw new PiContextMaterializationError("Pi host system message must not be recorded as a source");
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "custom":
    case "bashExecution":
    case "branchSummary":
    case "compactionSummary":
      return "contextual_user";
    case "toolResult":
      throw new PiContextMaterializationError("Pi tool result must be recorded as opaque source");
    default:
      return assertNever(message);
  }
}

function assertNever(value: never): never {
  throw new PiContextMaterializationError(
    `unsupported Pi AgentMessage role ${String((value as { role?: unknown }).role)}`,
  );
}

function userMessage(content: string): PiAgentMessage {
  return { role: "user", content, timestamp: 0 };
}

function spineProjectionMessage(
  customType: string,
  content: string,
  details: PiSpineProjectionDetails,
): PiAgentMessage {
  return {
    role: "custom",
    customType,
    content,
    display: false,
    timestamp: 0,
    details,
  };
}

function sourceIdKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}
