import type {
  CompactBarrier,
  EpochOrdinalId,
  ReplayItem,
  SamplingArchiveRecord,
  SourceCharacter,
  SourceSnapshot,
  SpineOperation,
  SpineRuntimeClient,
  Terminal,
} from "../index.js";

import {
  SpineController,
  type FinishSamplingResult,
  type PublishedContext,
  type SpineArchiveStore,
  type SpineCompactMetadata,
  type SpineContextPublisher,
} from "./controller.js";

export const SPINE_HOST_PROTOCOL_SCHEMA = "spine-host-protocol/v1" as const;

export interface HostOwnershipClaim {
  context: "exclusive-final";
  compaction: "exclusive";
}

export interface HostArchiveEnvelope {
  schema: typeof SPINE_HOST_PROTOCOL_SCHEMA;
  durabilityId: string;
  record: SamplingArchiveRecord;
}

export interface HostContextEnvelope<TMessage> extends PublishedContext {
  schema: typeof SPINE_HOST_PROTOCOL_SCHEMA;
  messages: readonly TMessage[];
}

export interface HostContextTransport<TMessage> {
  materialize(context: PublishedContext): Promise<readonly TMessage[]>;
  publishAtomic(context: HostContextEnvelope<TMessage>): Promise<void>;
}

export interface HostAdapterBinding<TMessage> {
  claimOwnership(claim: HostOwnershipClaim): Promise<void>;
  persistArchive(entry: HostArchiveEnvelope): Promise<void>;
  persistCompact?: (barrier: CompactBarrier, metadata?: SpineCompactMetadata) => Promise<void>;
  context: HostContextTransport<TMessage>;
}

export interface CreateHostAdapterOptions<TMessage> {
  runtime: SpineRuntimeClient;
  host: HostAdapterBinding<TMessage>;
  dispose?: () => void;
}

export class SpineHostAdapter {
  readonly #controller: SpineController;
  readonly #dispose: (() => void) | undefined;
  #disposed = false;

  constructor(controller: SpineController, dispose?: () => void) {
    this.#controller = controller;
    this.#dispose = dispose;
  }

  get fault() {
    return this.#controller.fault;
  }

  observeSources(characters: SourceCharacter[]): Promise<EpochOrdinalId[]> {
    return this.#controller.observeSources(characters);
  }

  beginSampling(): Promise<SamplingArchiveRecord> {
    return this.#controller.beginSampling();
  }

  registerExecution(key: string): Promise<void> {
    return this.#controller.registerExecution(key);
  }

  stageExecution(key: string, executionRef: string, operation: SpineOperation): Promise<void> {
    return this.#controller.stageExecution(key, executionRef, operation);
  }

  finishExecution(key: string, succeeded: boolean): Promise<void> {
    return this.#controller.finishExecution(key, succeeded);
  }

  finishSampling(terminal: Terminal, inputTokens?: number): Promise<FinishSamplingResult> {
    return this.#controller.finishSampling(
      inputTokens === undefined ? { terminal } : { terminal, inputTokens },
    );
  }

  compact(
    barrier: CompactBarrier,
    options: { publish?: boolean; metadata?: SpineCompactMetadata } = {},
  ): Promise<PublishedContext> {
    return this.#controller.compact(barrier, options);
  }

  async replay(inputs: ReplayItem[]): Promise<void> {
    await this.#controller.replay(inputs);
  }

  replayWithSources(
    inputs: ReplayItem[],
    installSources?: (source: SourceSnapshot) => Promise<void>,
  ): Promise<{ context: PublishedContext; source: SourceSnapshot }> {
    return this.#controller.replayWithSources(inputs, installSources);
  }

  previewAndPublish(): Promise<PublishedContext> {
    return this.#controller.previewAndPublish();
  }

  sourceSnapshot(): Promise<SourceSnapshot> {
    return this.#controller.sourceSnapshot();
  }

  continueNamespace(thread: string): Promise<SourceSnapshot> {
    return this.#controller.continueNamespace(thread);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dispose?.();
  }
}

export async function createHostAdapter<TMessage>(
  options: CreateHostAdapterOptions<TMessage>,
): Promise<SpineHostAdapter> {
  await options.host.claimOwnership({
    context: "exclusive-final",
    compaction: "exclusive",
  });

  const archive: SpineArchiveStore = {
    persist: (entry) =>
      options.host.persistArchive({
        schema: SPINE_HOST_PROTOCOL_SCHEMA,
        durabilityId: entry.durabilityId,
        record: entry.record,
      }),
    ...(options.host.persistCompact === undefined
      ? {}
      : {
          persistCompact: (barrier: CompactBarrier, metadata?: SpineCompactMetadata) =>
            options.host.persistCompact!(barrier, metadata),
        }),
  };
  const context: SpineContextPublisher = {
    publish: async (publication) => {
      const messages = await options.host.context.materialize(publication);
      await options.host.context.publishAtomic({
        schema: SPINE_HOST_PROTOCOL_SCHEMA,
        ...publication,
        messages,
      });
    },
  };

  return new SpineHostAdapter(
    new SpineController(options.runtime, archive, context),
    options.dispose,
  );
}
