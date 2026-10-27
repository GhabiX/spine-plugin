import type {
  CompactBarrier,
  SourceSnapshot,
  SpawnTask,
  SpineOperation,
  Terminal,
} from "@spinejit/spine-sdk";

import {
  decodeSpineSpawnTasks,
  isSpineToolName,
  operationFromSpineToolCall,
  SPINE_TOOL_NAMES,
  type FinishSamplingResult,
  type SpineHostAdapter,
  type SpineToolName,
} from "@spinejit/spine-sdk/host";
import { isPiHostSystemMessage, PiSourceBindings, sourceObservation, type PiAgentMessage } from "./messages.js";

export const PI_SPINE_TOOL_NAMES = SPINE_TOOL_NAMES;

export type PiSpineToolName = SpineToolName;

export interface PiTurnEnd {
  message: PiAgentMessage;
  aborted: boolean;
}

export class PiSamplingLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSamplingLifecycleError";
  }
}

/**
 * Admission denial for a second Spine tool call in one sampling: the core admits
 * one Spine operation per sampling. Not a lifecycle fault.
 */
export class PiSpineToolLimitError extends Error {
  constructor(staged: SpineToolName) {
    super(`only one Spine tool call is allowed per model response; ${staged} already ran in this one`);
    this.name = "PiSpineToolLimitError";
  }
}

/** Owns the exact one-Pi-provider-turn to one-Spine-sampling transaction mapping. */
export class PiSamplingLifecycle {
  readonly #adapter: SpineHostAdapter;
  readonly #bindings: PiSourceBindings;
  readonly #executions = new Set<string>();
  #nextBoundary: number;
  #contextVersion = 0;
  #publishedContextVersion = -1;
  #previewInFlight: Promise<void> | null = null;
  #samplingActive = false;
  #staged: SpineToolName | null = null;
  #fault: unknown = null;

  constructor(
    adapter: SpineHostAdapter,
    bindings: PiSourceBindings,
    source: SourceSnapshot,
    options: { contextReady?: boolean } = {},
  ) {
    this.#adapter = adapter;
    this.#bindings = bindings;
    this.#nextBoundary = nextSourceBoundary(source);
    this.#publishedContextVersion = options.contextReady === true ? 0 : -1;
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  async observeMessage(message: PiAgentMessage): Promise<void> {
    if (isPiHostSystemMessage(message)) return;
    await this.#guard(async () => {
      const observation = sourceObservation(message, this.#nextBoundary);
      const sourceIds = await this.#adapter.observeSources([observation.character]);
      const sourceId = sourceIds[0];
      if (sourceIds.length !== 1 || sourceId === undefined) {
        throw new PiSamplingLifecycleError(
          `Spine admitted ${sourceIds.length} source IDs for one Pi message`,
        );
      }
      this.#bindings.bind(sourceId, observation.message);
      this.#nextBoundary += 1;
      this.#contextVersion += 1;
    });
  }

  async previewContext(): Promise<void> {
    if (this.#contextVersion === this.#publishedContextVersion) return;
    if (this.#previewInFlight !== null) {
      await this.#previewInFlight;
      if (this.#contextVersion !== this.#publishedContextVersion) {
        await this.previewContext();
      }
      return;
    }
    const targetVersion = this.#contextVersion;
    const pending = this.#guard(async () => {
      await this.#adapter.previewAndPublish();
      if (this.#contextVersion === targetVersion) {
        this.#publishedContextVersion = targetVersion;
      }
    });
    this.#previewInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.#previewInFlight === pending) this.#previewInFlight = null;
    }
    if (this.#contextVersion !== this.#publishedContextVersion) {
      await this.previewContext();
    }
  }

  /** Admit durable host additions that Pi appends without extension message events. */
  async observePersistedSources(sources: readonly { boundary: number; message: PiAgentMessage }[]): Promise<void> {
    for (const source of sources) {
      if (source.boundary < this.#nextBoundary) continue;
      if (source.boundary !== this.#nextBoundary) {
        throw new PiSamplingLifecycleError("Persisted Pi source tail is discontinuous");
      }
      await this.observeMessage(source.message);
    }
  }

  async sourceSnapshot(): Promise<SourceSnapshot> {
    return this.#guard(() => this.#adapter.sourceSnapshot());
  }

  async compact(
    barrier: CompactBarrier,
    replacementMessages: readonly PiAgentMessage[],
    entryIds?: readonly (string | null)[],
  ): Promise<void> {
    await this.#guard(async () => {
      if (this.#samplingActive) {
        throw new PiSamplingLifecycleError("Pi compaction started before the sampling turn ended");
      }
      if (replacementMessages.length !== barrier.replacement_boundaries.length) {
        throw new PiSamplingLifecycleError(
          "Pi compact replacement messages do not match replacement boundaries",
        );
      }
      if (entryIds !== undefined && entryIds.length !== replacementMessages.length) {
        throw new PiSamplingLifecycleError(
          "Pi compact replacement entry ids do not match replacement messages",
        );
      }
      const targetVersion = ++this.#contextVersion;
      await this.#adapter.compact(barrier, {
        publish: false,
        metadata: entryIds === undefined
          ? replacementMessages
          : { messages: replacementMessages, entryIds },
      });
      const source = await this.#adapter.sourceSnapshot();
      if (source.cells.length !== replacementMessages.length) {
        throw new PiSamplingLifecycleError(
          `Spine compact returned ${source.cells.length} source cells for ${replacementMessages.length} replacements`,
        );
      }
      this.#bindings.clear();
      for (const cell of source.cells) {
        const index = barrier.replacement_boundaries.indexOf(cell.boundary);
        if (index < 0) {
          throw new PiSamplingLifecycleError(
            `Spine compact returned an unexpected replacement boundary ${cell.boundary}`,
          );
        }
        this.#bindings.bind(cell.source_id, replacementMessages[index]!, entryIds?.[index] ?? null);
      }
      this.#nextBoundary = nextSourceBoundary(source);
      await this.#adapter.previewAndPublish();
      if (this.#contextVersion === targetVersion) {
        this.#publishedContextVersion = targetVersion;
      }
    });
  }

  async beginSampling(): Promise<void> {
    await this.#guard(async () => {
      if (this.#samplingActive) {
        throw new PiSamplingLifecycleError("Pi started a model request before the prior turn ended");
      }
      await this.#adapter.beginSampling();
      this.#samplingActive = true;
      this.#executions.clear();
      this.#staged = null;
    });
  }

  async registerToolCall(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isSpineToolName(toolName)) {
      return false;
    }
    if (this.fault !== null) {
      throw new PiSamplingLifecycleError("Pi Spine lifecycle is faulted", {
        cause: this.fault,
      });
    }
    const operation = operationFromPiToolCall(toolName, input);
    if (this.#staged !== null) {
      throw new PiSpineToolLimitError(this.#staged);
    }
    this.#staged = toolName;
    await this.#guard(async () => {
      this.#assertSamplingActive();
      if (this.#executions.has(toolCallId)) {
        throw new PiSamplingLifecycleError(`duplicate Pi Spine tool call ${toolCallId}`);
      }
      await this.#adapter.registerExecution(toolCallId);
      this.#executions.add(toolCallId);
      await this.#adapter.stageExecution(toolCallId, toolCallId, operation);
    });
    return true;
  }

  async finishToolCall(toolCallId: string, succeeded: boolean): Promise<boolean> {
    if (!this.#executions.has(toolCallId)) {
      return false;
    }
    await this.#guard(async () => {
      await this.#adapter.finishExecution(toolCallId, succeeded);
      this.#executions.delete(toolCallId);
    });
    return true;
  }

  async finishTurn(turn: PiTurnEnd): Promise<FinishSamplingResult | null> {
    return this.#guard(async () => {
      // Close is idempotent: Pi may emit a stray turn_end after sampling is already closed.
      if (!this.#samplingActive) {
        return null;
      }
      if (this.#executions.size !== 0) {
        if (!samplingWasCancelled(turn)) {
          throw new PiSamplingLifecycleError(
            `Pi turn ended with unfinished Spine executions: ${[...this.#executions].join(", ")}`,
          );
        }
        // Pi may skip afterToolCall on immediate abort after register. Drain like
        // Codex ExecutionGuard Drop: fail leftover executions, then cancel sampling.
        for (const key of [...this.#executions]) {
          await this.#adapter.finishExecution(key, false);
          this.#executions.delete(key);
        }
      }
      const targetVersion = this.#contextVersion;
      const result = await this.#adapter.finishSampling(
        samplingTerminal(turn),
        assistantInputTokens(turn.message),
      );
      this.#samplingActive = false;
      if (result.type === "committed" && this.#contextVersion === targetVersion) {
        this.#publishedContextVersion = targetVersion;
      }
      return result;
    });
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fault !== null) {
      throw new PiSamplingLifecycleError("Pi Spine lifecycle is faulted", {
        cause: this.fault,
      });
    }
    try {
      return await operation();
    } catch (cause) {
      this.#fault ??= cause;
      throw new PiSamplingLifecycleError("Pi Spine lifecycle fault", { cause });
    }
  }

  #assertSamplingActive(): void {
    if (!this.#samplingActive) {
      throw new PiSamplingLifecycleError("Pi Spine operation occurred outside sampling");
    }
  }

}

export function buildCompactBarrier(
  source: SourceSnapshot,
  replacementCount: number,
): CompactBarrier {
  if (!Number.isSafeInteger(replacementCount) || replacementCount <= 0) {
    throw new PiSamplingLifecycleError("Pi compact requires at least one replacement message");
  }
  const boundary = nextSourceBoundary(source);
  if (!Number.isSafeInteger(boundary)) {
    throw new PiSamplingLifecycleError("Pi compact source boundary is exhausted");
  }
  const nextEpoch = source.epoch + 1;
  if (!Number.isSafeInteger(nextEpoch)) {
    throw new PiSamplingLifecycleError("Pi compact context epoch is exhausted");
  }
  const replacementBoundaries = Array.from(
    { length: replacementCount },
    (_, index) => boundary + index + 1,
  );
  if (!Number.isSafeInteger(replacementBoundaries.at(-1))) {
    throw new PiSamplingLifecycleError("Pi compact replacement boundary is exhausted");
  }
  return {
    schema: "spine.compact.barrier.v1" as const,
    thread: source.thread,
    previous_epoch: source.epoch,
    next_epoch: nextEpoch,
    boundary,
    replacement_boundaries: replacementBoundaries,
  };
}

export function operationFromPiToolCall(
  toolName: PiSpineToolName,
  input: Record<string, unknown>,
): SpineOperation {
  try {
    return operationFromSpineToolCall(toolName, input);
  } catch (cause) {
    throw new PiSamplingLifecycleError("invalid Pi Spine tool input", { cause });
  }
}

export function decodeSpawnTasks(input: Record<string, unknown>): SpawnTask[] {
  try {
    return decodeSpineSpawnTasks(input);
  } catch (cause) {
    throw new PiSamplingLifecycleError("invalid Pi Spine Spawn input", { cause });
  }
}

function samplingWasCancelled(turn: PiTurnEnd): boolean {
  if (turn.aborted) {
    return true;
  }
  return turn.message.role === "assistant" && turn.message.stopReason === "aborted";
}

function samplingTerminal(turn: PiTurnEnd): Terminal {
  if (turn.aborted) {
    return "cancelled";
  }
  if (turn.message.role !== "assistant") {
    throw new PiSamplingLifecycleError("Pi turn_end did not carry an assistant message");
  }
  switch (turn.message.stopReason) {
    case "aborted":
      return "cancelled";
    case "error":
      return "failed";
    case "stop":
    case "toolUse":
    case "length":
      return "completed";
    case "deferred":
      throw new PiSamplingLifecycleError(
        "Pi deferred assistant responses are unsupported by the Spine sampling contract",
      );
    default:
      throw new PiSamplingLifecycleError(
        `Pi assistant response has unsupported stop reason ${String(turn.message.stopReason)}`,
      );
  }
}

function assistantInputTokens(message: PiAgentMessage): number | undefined {
  if (message.role !== "assistant") {
    throw new PiSamplingLifecycleError("Pi turn_end did not carry an assistant message");
  }
  const usage = message.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const usageRecord = usage as Record<string, unknown>;
  const components = [usageRecord.input, usageRecord.cacheRead, usageRecord.cacheWrite];
  if (
    !components.every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    return undefined;
  }
  let total = 0;
  for (const value of components) {
    total += value as number;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function nextSourceBoundary(source: SourceSnapshot): number {
  let next = 0;
  for (const cell of source.cells) {
    next = Math.max(next, cell.boundary + 1);
  }
  return next;
}
