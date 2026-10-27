import type {
  ReplayItem,
  SamplingArchiveRecord,
  SourceSnapshot,
  SpineRuntimeClient,
} from "@spinejit/spine-sdk";

import type { SpineHostAdapter } from "../host-adapter.js";
import {
  DEEPSEEK_HARNESS_ADAPTER_ID,
  DEEPSEEK_HARNESS_ARCHIVE_EVENT,
  DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT,
  type DeepSeekHarnessArchiveEvent,
  type DeepSeekHarnessSessionEvent,
} from "./index.js";
import {
  DeepSeekHarnessSourceBindings,
  observeDeepSeekHarnessMessage,
  type DeepSeekHarnessMessage,
} from "./messages.js";

export interface DeepSeekHarnessReplayPlan {
  runtimeThread: string;
  currentSessionId: string;
  inputs: ReplayItem[];
  sources: Array<{ boundary: number; message: DeepSeekHarnessMessage }>;
}

export interface RecoverDeepSeekHarnessSessionOptions {
  plan: DeepSeekHarnessReplayPlan;
  runtimeFactory(thread: string): SpineRuntimeClient;
  adapterFactory(
    runtime: SpineRuntimeClient,
    bindings: DeepSeekHarnessSourceBindings,
  ): Promise<SpineHostAdapter>;
}

export interface RecoveredDeepSeekHarnessSession {
  adapter: SpineHostAdapter;
  bindings: DeepSeekHarnessSourceBindings;
  source: SourceSnapshot;
}

export class DeepSeekHarnessRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekHarnessRecoveryError";
  }
}

export function buildDeepSeekHarnessReplayPlan(
  currentSessionId: string,
  events: readonly DeepSeekHarnessSessionEvent[],
): DeepSeekHarnessReplayPlan {
  const inputs: ReplayItem[] = [];
  const sources: Array<{ boundary: number; message: DeepSeekHarnessMessage }> = [];
  let firstArchiveThread: string | null = null;
  let boundary = 0;
  for (const event of events) {
    if (event.type.startsWith("compaction/")) {
      throw new DeepSeekHarnessRecoveryError(
        `DSH native compaction event ${event.type} violates Spine compaction ownership`,
      );
    }
    if (event.type === DEEPSEEK_HARNESS_ARCHIVE_EVENT) {
      const archive = decodeArchive(event.data);
      firstArchiveThread ??= archive.record.record.attempt_id.thread;
      inputs.push({ type: "archive", record: archive.record });
      continue;
    }
    if (
      event.type === "surface/projection" ||
      event.type === DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT
    ) {
      continue;
    }
    const message = eventMessage(event);
    if (message === null) continue;
    const observation = observeDeepSeekHarnessMessage(message, boundary);
    inputs.push({ type: "source", character: observation.character });
    sources.push({ boundary, message: observation.message });
    boundary += 1;
  }
  return {
    runtimeThread: firstArchiveThread ?? currentSessionId,
    currentSessionId,
    inputs,
    sources,
  };
}

export async function recoverDeepSeekHarnessSession(
  options: RecoverDeepSeekHarnessSessionOptions,
): Promise<RecoveredDeepSeekHarnessSession> {
  const bindings = new DeepSeekHarnessSourceBindings();
  const runtime = options.runtimeFactory(options.plan.runtimeThread);
  const adapter = await options.adapterFactory(runtime, bindings);
  try {
    let source: SourceSnapshot | null = null;
    await adapter.replayWithSources(options.plan.inputs, async (snapshot) => {
      installDeepSeekHarnessSourceBindings(bindings, snapshot, options.plan.sources);
      source = snapshot;
    });
    if (options.plan.runtimeThread !== options.plan.currentSessionId) {
      source = await adapter.continueNamespace(options.plan.currentSessionId);
      installDeepSeekHarnessSourceBindings(bindings, source, options.plan.sources);
      await adapter.previewAndPublish();
    }
    if (source === null) {
      throw new DeepSeekHarnessRecoveryError("DSH Spine replay returned no source snapshot");
    }
    return { adapter, bindings, source };
  } catch (cause) {
    try {
      adapter.dispose();
    } catch (disposeCause) {
      throw new AggregateError(
        [cause, disposeCause],
        "DSH Spine recovery failed and adapter cleanup failed",
      );
    }
    throw cause;
  }
}

export function installDeepSeekHarnessSourceBindings(
  bindings: DeepSeekHarnessSourceBindings,
  source: SourceSnapshot,
  observations: readonly { boundary: number; message: DeepSeekHarnessMessage }[],
): void {
  if (source.cells.length !== observations.length) {
    throw new DeepSeekHarnessRecoveryError(
      `Spine source snapshot has ${source.cells.length} cells for ${observations.length} DSH messages`,
    );
  }
  const byBoundary = new Map(observations.map((item) => [item.boundary, item.message]));
  if (byBoundary.size !== observations.length) {
    throw new DeepSeekHarnessRecoveryError("DSH replay has duplicate source boundaries");
  }
  bindings.clear();
  for (const cell of source.cells) {
    const message = byBoundary.get(cell.boundary);
    if (message === undefined) {
      throw new DeepSeekHarnessRecoveryError(
        `Spine source cell ${cell.source_id.ordinal} has unknown boundary ${cell.boundary}`,
      );
    }
    bindings.bind(cell.source_id, message);
  }
}

function eventMessage(event: DeepSeekHarnessSessionEvent): DeepSeekHarnessMessage | null {
  if (event.type === "user/message") return requireMessage(event.data, event.type);
  if (event.type === "assistant/message" || event.type === "tool/result") {
    if (!isRecord(event.data)) {
      throw new DeepSeekHarnessRecoveryError(`${event.type} has no typed payload`);
    }
    return requireMessage(event.data.message, event.type);
  }
  return null;
}

function requireMessage(value: unknown, type: string): DeepSeekHarnessMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.role !== "system" && value.role !== "user" && value.role !== "assistant") ||
    !Array.isArray(value.content) ||
    !isRecord(value.source) ||
    typeof value.source.kind !== "string"
  ) {
    throw new DeepSeekHarnessRecoveryError(`${type} has an invalid DSH Message`);
  }
  return value as unknown as DeepSeekHarnessMessage;
}

function decodeArchive(value: unknown): DeepSeekHarnessArchiveEvent {
  if (
    !isRecord(value) ||
    value.schema !== DEEPSEEK_HARNESS_ADAPTER_ID ||
    typeof value.durabilityId !== "string" ||
    !isRecord(value.record) ||
    !isRecord(value.record.record)
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive is malformed");
  }
  const archive = value as unknown as DeepSeekHarnessArchiveEvent;
  const record = archive.record.record;
  if (
    archive.record.type !== "sampling_started" &&
    archive.record.type !== "sampling_commit"
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive type is unknown");
  }
  if (
    !isRecord(record.attempt_id) ||
    typeof record.attempt_id.thread !== "string" ||
    record.attempt_id.thread.length === 0
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive identity is inconsistent");
  }
  return archive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
