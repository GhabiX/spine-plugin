import type {
  CompactBarrier,
  CommandResult,
  ContextPlanRecipe,
  EpochOrdinalId,
  ReplayItem,
  SamplingArchiveRecord,
  SourceCharacter,
  SpineOperation,
  SpineProjection,
  SpineRuntimeClient,
  SourceSnapshot,
  Terminal,
} from "../index.js";
import { encodeCommand } from "../index.js";

const REPLAY_APPLY_PACK_BUDGET_BYTES = 1024 * 1024;

export interface DurableArchiveEntry {
  durabilityId: string;
  record: SamplingArchiveRecord;
}

export interface PublishedContext {
  transactionId: string | null;
  contextPlan: ContextPlanRecipe | null;
  projection: SpineProjection;
}

export type SpineCompactMetadata =
  | readonly unknown[]
  | {
      messages: readonly unknown[];
      entryIds: readonly (string | null)[];
    };

export interface SpineArchiveStore {
  persist(entry: DurableArchiveEntry): Promise<void>;
  persistCompact?: (barrier: CompactBarrier, metadata?: SpineCompactMetadata) => Promise<void>;
}

export interface SpineContextPublisher {
  publish(context: PublishedContext): Promise<void>;
}

export interface SpineControllerOptions {
  enabled: boolean;
  runtime: SpineRuntimeClient;
  archive: SpineArchiveStore;
  context: SpineContextPublisher;
}

export interface FinishSamplingInput {
  terminal: Terminal;
  inputTokens?: number;
}

export type FinishSamplingResult =
  | { type: "orphaned" }
  | {
      type: "committed";
      transactionId: string;
      record: SamplingArchiveRecord;
      contextPlan: ContextPlanRecipe;
      projection: SpineProjection;
    };

export interface SpineControllerFault {
  stage: ControllerStage;
  cause: unknown;
}

export type ControllerStage =
  | "runtime"
  | "persist"
  | "discard"
  | "install"
  | "restore"
  | "publish";

export class SpineControllerError extends Error {
  readonly fault: SpineControllerFault;

  constructor(fault: SpineControllerFault) {
    super(`Spine controller fault at ${fault.stage}`, { cause: fault.cause });
    this.name = "SpineControllerError";
    this.fault = fault;
  }
}

export function createSpineController(options: SpineControllerOptions): SpineController | null {
  if (!options.enabled) {
    return null;
  }
  return new SpineController(options.runtime, options.archive, options.context);
}

export class SpineController {
  readonly #runtime: SpineRuntimeClient;
  readonly #archive: SpineArchiveStore;
  readonly #context: SpineContextPublisher;
  #fault: SpineControllerFault | null = null;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    runtime: SpineRuntimeClient,
    archive: SpineArchiveStore,
    context: SpineContextPublisher,
  ) {
    this.#runtime = runtime;
    this.#archive = archive;
    this.#context = context;
  }

  get fault(): SpineControllerFault | null {
    return this.#fault;
  }

  async observeSources(characters: SourceCharacter[]): Promise<EpochOrdinalId[]> {
    return this.#exclusive(async () => {
      const result = expectResult(
        await this.#executeRuntime({ type: "observe_sources", characters }),
        "sources_observed",
      );
      return result.source_ids;
    });
  }

  async beginSampling(): Promise<SamplingArchiveRecord> {
    return this.#exclusive(async () => {
      const result = await this.#executeRuntime({ type: "begin_sampling" });
      const started = expectResult(result, "sampling_started").record;
      try {
        await this.#archive.persist({
          durabilityId: archiveRecordId(started),
          record: started,
        });
      } catch (cause) {
        throw this.#latch("persist", cause);
      }
      return started;
    });
  }

  async registerExecution(key: string): Promise<void> {
    return this.#exclusive(async () => {
      expectResult(
        await this.#executeRuntime({ type: "register_execution", key }),
        "execution_registered",
      );
    });
  }

  async stageExecution(key: string, executionRef: string, operation: SpineOperation): Promise<void> {
    return this.#exclusive(async () => {
      expectResult(
        await this.#executeRuntime({
          type: "stage_execution",
          key,
          execution_ref: executionRef,
          operation,
        }),
        "execution_staged",
      );
    });
  }

  async finishExecution(key: string, succeeded: boolean): Promise<void> {
    return this.#exclusive(async () => {
      expectResult(
        await this.#executeRuntime({ type: "finish_execution", key, succeeded }),
        "execution_finished",
      );
    });
  }

  async finishSampling(input: FinishSamplingInput): Promise<FinishSamplingResult> {
    return this.#exclusive(() => this.#finishSampling(input));
  }

  async compact(
    barrier: CompactBarrier,
    options: { publish?: boolean; metadata?: SpineCompactMetadata } = {},
  ): Promise<PublishedContext> {
    return this.#exclusive(async () => {
      this.#assertHealthy();
      try {
        // Persist the barrier before mutating the runtime. Recovery replays the
        // durable barrier if the process exits between these two operations.
        if (this.#archive.persistCompact === undefined) {
          throw new Error("Spine compact persistence is unavailable");
        }
        await this.#archive.persistCompact(barrier, options.metadata);
      } catch (cause) {
        throw this.#latch("persist", cause);
      }

      let compacted: Extract<CommandResult, { type: "compacted" }>;
      try {
        compacted = expectResult(
          await this.#executeRuntime({ type: "compact", barrier }),
          "compacted",
        );
      } catch (cause) {
        throw this.#latch("runtime", cause);
      }
      const context: PublishedContext = {
        transactionId: null,
        contextPlan: compacted.context_plan,
        projection: compacted.projection,
      };
      if (options.publish !== false) {
        try {
          await this.#context.publish(context);
        } catch (cause) {
          throw this.#latch("publish", cause);
        }
      }
      return context;
    });
  }

  async #finishSampling(input: FinishSamplingInput): Promise<FinishSamplingResult> {
    this.#assertHealthy();
    let prepared: Extract<CommandResult, { type: "finish_prepared" }>;
    try {
      const command = input.inputTokens === undefined
        ? { type: "prepare_finish" as const, terminal: input.terminal }
        : {
            type: "prepare_finish" as const,
            terminal: input.terminal,
            input_tokens: input.inputTokens,
          };
      const result = await this.#runtime.execute(command);
      if (result.type === "sampling_orphaned") {
        return { type: "orphaned" };
      }
      prepared = expectResult(result, "finish_prepared");
    } catch (cause) {
      throw this.#latch("runtime", cause);
    }

    try {
      await this.#archive.persist({
        durabilityId: prepared.transaction_id,
        record: prepared.record,
      });
    } catch (cause) {
      const fault: SpineControllerFault = { stage: "persist", cause };
      this.#fault = fault;
      try {
        expectResult(
          await this.#runtime.execute({
            type: "discard_prepared",
            transaction_id: prepared.transaction_id,
          }),
          "prepared_discarded",
        );
      } catch (discardCause) {
        fault.cause = new AggregateError(
          [cause, discardCause],
          "persistence failed and prepared state could not be discarded",
        );
      }
      throw new SpineControllerError(fault);
    }

    let installed: Extract<CommandResult, { type: "prepared_installed" }>;
    try {
      installed = expectResult(
        await this.#runtime.execute({
          type: "install_prepared",
          transaction_id: prepared.transaction_id,
        }),
        "prepared_installed",
      );
    } catch (cause) {
      throw this.#latch("install", cause);
    }

    try {
      await this.#context.publish({
        transactionId: installed.transaction_id,
        contextPlan: installed.context_plan,
        projection: installed.projection,
      });
    } catch (cause) {
      throw this.#latch("publish", cause);
    }

    return {
      type: "committed",
      transactionId: installed.transaction_id,
      record: prepared.record,
      contextPlan: installed.context_plan,
      projection: installed.projection,
    };
  }

  async replay(inputs: ReplayItem[]): Promise<PublishedContext> {
    return this.#exclusive(() => this.#replay(inputs));
  }

  async replayWithSources(
    inputs: ReplayItem[],
    installSources: (source: SourceSnapshot) => Promise<void> = async () => {},
  ): Promise<{ context: PublishedContext; source: SourceSnapshot }> {
    return this.#exclusive(async () => {
      const replay = await this.#replayResult(inputs);
      try {
        await installSources(replay.source);
      } catch (cause) {
        throw this.#latch("restore", cause);
      }
      const context = await this.#publishReplay(replay);
      return { context, source: replay.source };
    });
  }

  async #replay(inputs: ReplayItem[]): Promise<PublishedContext> {
    return this.#publishReplay(await this.#replayResult(inputs));
  }

  async #replayResult(inputs: ReplayItem[]) {
    expectResult(await this.#executeRuntime({ type: "replay_begin" }), "replay_begun");
    for (const batch of packReplayApplyBatches(inputs)) {
      expectResult(
        await this.#executeRuntime({ type: "replay_apply", inputs: batch }),
        "replay_applied",
      );
    }
    return expectResult(await this.#executeRuntime({ type: "replay_finish" }), "replay_installed");
  }

  async #publishReplay(
    replay: Extract<CommandResult, { type: "replay_installed" }>,
  ): Promise<PublishedContext> {
    const context: PublishedContext = {
      transactionId: null,
      contextPlan: replay.context_plan,
      projection: replay.projection,
    };
    try {
      await this.#context.publish(context);
    } catch (cause) {
      throw this.#latch("publish", cause);
    }
    return context;
  }

  async preview(): Promise<PublishedContext> {
    return this.#exclusive(async () => {
      const preview = expectResult(await this.#executeRuntime({ type: "preview" }), "preview");
      return {
        transactionId: null,
        contextPlan: preview.context_plan,
        projection: preview.projection,
      };
    });
  }

  async previewAndPublish(): Promise<PublishedContext> {
    return this.#exclusive(async () => {
      const preview = expectResult(await this.#executeRuntime({ type: "preview" }), "preview");
      const context: PublishedContext = {
        transactionId: null,
        contextPlan: preview.context_plan,
        projection: preview.projection,
      };
      try {
        await this.#context.publish(context);
      } catch (cause) {
        throw this.#latch("publish", cause);
      }
      return context;
    });
  }

  async sourceSnapshot(): Promise<SourceSnapshot> {
    return this.#exclusive(async () =>
      expectResult(await this.#executeRuntime({ type: "source_snapshot" }), "source_snapshot").source
    );
  }

  async continueNamespace(thread: string): Promise<SourceSnapshot> {
    return this.#exclusive(async () =>
      expectResult(
        await this.#executeRuntime({ type: "continue_namespace", thread }),
        "namespace_continued",
      ).source
    );
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #executeRuntime(
    command: Parameters<SpineRuntimeClient["execute"]>[0],
  ): Promise<CommandResult> {
    this.#assertHealthy();
    try {
      return await this.#runtime.execute(command);
    } catch (cause) {
      throw this.#latch("runtime", cause);
    }
  }

  #assertHealthy(): void {
    if (this.#fault !== null) {
      throw new SpineControllerError(this.#fault);
    }
  }

  #latch(stage: ControllerStage, cause: unknown): SpineControllerError {
    if (this.#fault === null) {
      this.#fault = { stage, cause };
    }
    return new SpineControllerError(this.#fault);
  }
}

export function archiveRecordId(record: SamplingArchiveRecord): string {
  if (record.type === "sampling_commit") {
    return record.record.commit_id.value;
  }
  return record.record.attempt_id.value;
}

export function packReplayApplyBatches(inputs: readonly ReplayItem[]): ReplayItem[][] {
  const emptyBytes = replayApplyBytes([]);
  const batches: ReplayItem[][] = [];
  let current: ReplayItem[] = [];
  let currentBytes = emptyBytes;
  for (const item of inputs) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const extra = current.length === 0 ? itemBytes - 2 : itemBytes + 1;
    if (current.length > 0 && currentBytes + extra > REPLAY_APPLY_PACK_BUDGET_BYTES) {
      batches.push(current);
      current = [item];
      currentBytes = emptyBytes + itemBytes - 2;
      continue;
    }
    current.push(item);
    currentBytes += extra;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function replayApplyBytes(inputs: readonly ReplayItem[]): number {
  return Buffer.byteLength(encodeCommand({ type: "replay_apply", inputs: [...inputs] }), "utf8");
}

function expectResult<T extends CommandResult["type"]>(
  result: CommandResult,
  type: T,
): Extract<CommandResult, { type: T }> {
  if (result.type !== type) {
    throw new Error(`expected Spine result ${type}, received ${result.type}`);
  }
  return result as Extract<CommandResult, { type: T }>;
}
