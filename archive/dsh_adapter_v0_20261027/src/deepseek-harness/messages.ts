import type {
  ContextItem,
  ContextPlanCell,
  EpochOrdinalId,
  SourceCharacter,
} from "@spinejit/spine-sdk";

import type { PublishedContext } from "../controller.js";

export interface DeepSeekHarnessContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface DeepSeekHarnessMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly content: readonly DeepSeekHarnessContentBlock[];
  readonly source: { readonly kind: string; readonly [key: string]: unknown };
}

export interface DeepSeekHarnessSourceObservation {
  character: SourceCharacter;
  message: DeepSeekHarnessMessage;
}

export class DeepSeekHarnessContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekHarnessContextError";
  }
}

export class DeepSeekHarnessSourceBindings {
  readonly #messages = new Map<string, DeepSeekHarnessMessage>();

  bind(sourceId: EpochOrdinalId, message: DeepSeekHarnessMessage): void {
    const key = sourceIdKey(sourceId);
    if (this.#messages.has(key)) {
      throw new DeepSeekHarnessContextError(`duplicate DSH source binding ${key}`);
    }
    this.#messages.set(key, structuredClone(message));
  }

  resolve(sourceId: EpochOrdinalId): DeepSeekHarnessMessage {
    const message = this.#messages.get(sourceIdKey(sourceId));
    if (message === undefined) {
      throw new DeepSeekHarnessContextError(
        `missing DSH message for source ${sourceIdKey(sourceId)}`,
      );
    }
    return structuredClone(message);
  }

  clear(): void {
    this.#messages.clear();
  }
}

export function observeDeepSeekHarnessMessage(
  message: DeepSeekHarnessMessage,
  boundary: number,
): DeepSeekHarnessSourceObservation {
  if (message.source.kind === "tool") {
    return { character: { type: "opaque", boundary }, message };
  }
  return {
    character: {
      type: "message",
      boundary,
      role: sourceRole(message),
      content: stableJson(message),
    },
    message,
  };
}

export function materializeDeepSeekHarnessContext(
  context: PublishedContext,
  bindings: DeepSeekHarnessSourceBindings,
): DeepSeekHarnessMessage[] {
  if (context.contextPlan === null) return [];
  return context.contextPlan.cells.map((cell) => {
    if (cell.type === "projection") return materializeProjection(cell);
    let message = bindings.resolve(cell.source_id);
    for (const label of cell.labels) {
      message = prependUserAnchor(message, label.UserAnchor);
    }
    return message;
  });
}

function materializeProjection(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
): DeepSeekHarnessMessage {
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const node = item.SyntheticNode;
    return syntheticMessage(
      cell,
      `<spine_node id="${node.node_id.join(".")}" summary="${escapeXmlAttribute(node.summary)}" status="${node.status.toLowerCase()}">\n</spine_node>`,
    );
  }
  if ("MemorySlot" in item && "Summary" in item.MemorySlot) {
    const memory = item.MemorySlot.Summary;
    return syntheticMessage(
      cell,
      `<spine_memory node_id="${memory.owner_node.join(".")}">\n${memory.body}\n</spine_memory>`,
    );
  }
  if ("MemorySlot" in item && "SpawnEvidence" in item.MemorySlot) {
    const evidence = item.MemorySlot.SpawnEvidence;
    return syntheticMessage(
      cell,
      `<spine_spawn_evidence node_id="${evidence.owner_node.join(".")}">\n${JSON.stringify({
        summary: evidence.task.summary,
        prompt: evidence.task.prompt,
        outcome: evidence.outcome,
        diagnostic: evidence.diagnostic,
        execution_ref: evidence.execution_ref,
      }, null, 2)}\n</spine_spawn_evidence>`,
    );
  }
  throw unsupportedProjection(item);
}

function syntheticMessage(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
  text: string,
): DeepSeekHarnessMessage {
  return {
    id: `spine:${cell.projection_id.thread}:${cell.projection_id.epoch}:${cell.projection_id.ordinal}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "spine", form: "recall" },
  };
}

function prependUserAnchor(
  message: DeepSeekHarnessMessage,
  anchor: number,
): DeepSeekHarnessMessage {
  if (message.role !== "user" || message.source.kind !== "user") {
    throw new DeepSeekHarnessContextError(
      `Spine user anchor U${anchor} targets a non-user DSH message`,
    );
  }
  const copy = structuredClone(message);
  const content = [...copy.content];
  const firstText = content.findIndex((block) => block.type === "text");
  if (firstText < 0) {
    content.unshift({ type: "text", text: `[U${anchor}]\n` });
  } else {
    const block = content[firstText] as { type: string; text?: unknown };
    if (typeof block.text !== "string") {
      throw new DeepSeekHarnessContextError(`DSH text block for U${anchor} has no text`);
    }
    content[firstText] = { ...block, text: `[U${anchor}]\n${block.text}` };
  }
  return { ...copy, content };
}

function sourceRole(
  message: DeepSeekHarnessMessage,
): "user" | "contextual_user" | "assistant" | "system" {
  if (message.role === "assistant") return "assistant";
  if (message.role === "system") return "system";
  if (message.source.kind === "user") return "user";
  if (message.source.kind === "tool") {
    throw new DeepSeekHarnessContextError("DSH tool result must be admitted as opaque source");
  }
  return "contextual_user";
}

function unsupportedProjection(item: ContextItem): DeepSeekHarnessContextError {
  return new DeepSeekHarnessContextError(
    `DSH cannot materialize Spine projection item ${Object.keys(item)[0] ?? "unknown"}`,
  );
}

function sourceIdKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
