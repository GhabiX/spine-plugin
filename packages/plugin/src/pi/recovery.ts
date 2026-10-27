import type {
  ReplayItem,
  SamplingArchiveRecord,
  SourceSnapshot,
  SpineRuntimeClient,
} from "@spinejit/spine-sdk";

import { archiveRecordId, type SpineHostAdapter } from "@spinejit/spine-sdk/host";
import { isPiHostSystemMessage, PiSourceBindings, sourceObservation, type PiAgentMessage } from "./messages.js";
import {
  PI_ADAPTER_ID,
  PI_ARCHIVE_ENTRY_TYPE,
  PI_COMPACT_ENTRY_TYPE,
  type PiSpineArchiveEntry,
  type PiSpineCompactEntry,
} from "./protocol.js";

export interface PiBranchEntry {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  fromHook?: boolean;
}

export interface PiReplaySource {
  boundary: number;
  message: PiAgentMessage;
  entryId: string | null;
}

export interface PiReplayPlan {
  runtimeThread: string;
  currentSessionId: string;
  inputs: ReplayItem[];
  sources: PiReplaySource[];
}

export interface BuildPiReplayPlanOptions {
  currentSessionId: string;
  branch: readonly PiBranchEntry[];
  messagesForEntry(entry: PiBranchEntry): readonly PiAgentMessage[];
}

export interface RecoverPiSessionOptions {
  plan: PiReplayPlan;
  runtimeFactory(thread: string): SpineRuntimeClient;
  adapterFactory(runtime: SpineRuntimeClient, bindings: PiSourceBindings): Promise<SpineHostAdapter>;
}

export interface RecoveredPiSession {
  adapter: SpineHostAdapter;
  bindings: PiSourceBindings;
  source: SourceSnapshot;
}

export class PiSessionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionRecoveryError";
  }
}

export function buildPiReplayPlan(options: BuildPiReplayPlanOptions): PiReplayPlan {
  const inputs: ReplayItem[] = [];
  let sources: PiReplaySource[] = [];
  let firstArchiveThread: string | null = null;
  let boundary = 0;
  let compactAwaitingPiEntry = false;

  for (const entry of options.branch) {
    if (entry.type === "compaction") {
      if (!compactAwaitingPiEntry) {
        throw new PiSessionRecoveryError(
          "Pi native compaction entry violates Spine compaction ownership",
        );
      }
      if (entry.fromHook !== true) {
        throw new PiSessionRecoveryError(
          "Pi native compaction acknowledgement is not owned by the Spine hook",
        );
      }
      compactAwaitingPiEntry = false;
      const summary = sources[0];
      if (
        summary !== undefined &&
        summary.entryId === null &&
        typeof entry.id === "string" &&
        entry.id.length > 0
      ) {
        summary.entryId = entry.id;
      }
      continue;
    }
    if (compactAwaitingPiEntry) {
      throw new PiSessionRecoveryError(
        "Pi Spine compact entry was not immediately acknowledged by native compaction",
      );
    }

    if (entry.type === "custom" && entry.customType === PI_ARCHIVE_ENTRY_TYPE) {
      const archive = decodeArchiveEntry(entry.data);
      firstArchiveThread ??= archive.record.record.attempt_id.thread;
      inputs.push({ type: "archive", record: archive.record });
      continue;
    }
    if (entry.type === "custom" && entry.customType === PI_COMPACT_ENTRY_TYPE) {
      const compact = decodeCompactEntry(entry.data);
      firstArchiveThread ??= compact.barrier.thread;
      compactAwaitingPiEntry = true;
      inputs.push({ type: "compact", barrier: compact.barrier });
      if (
        compact.replacementMessages.length === 0 ||
        compact.replacementMessages.length !== compact.barrier.replacement_boundaries.length
      ) {
        throw new PiSessionRecoveryError(
          "Pi Spine compact replacement message count does not match barrier boundaries",
        );
      }
      sources = compact.replacementMessages.map((message, index) => ({
        boundary: compact.barrier.replacement_boundaries[index]!,
        message: message as PiAgentMessage,
        entryId: storedEntryId(compact.replacementEntryIds, index),
      }));
      boundary = compact.barrier.replacement_boundaries.at(-1)! + 1;
      continue;
    }

    for (const message of options.messagesForEntry(entry)) {
      if (isPiHostSystemMessage(message)) continue;
      const observation = sourceObservation(message, boundary);
      inputs.push({ type: "source", character: observation.character });
      sources.push({
        boundary,
        message: observation.message,
        entryId: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
      });
      boundary += 1;
    }
  }

  if (compactAwaitingPiEntry) {
    throw new PiSessionRecoveryError(
      "Pi Spine compact entry is missing its native compaction acknowledgement",
    );
  }

  return {
    runtimeThread: firstArchiveThread ?? options.currentSessionId,
    currentSessionId: options.currentSessionId,
    inputs,
    sources,
  };
}

export async function recoverPiSession(
  options: RecoverPiSessionOptions,
): Promise<RecoveredPiSession> {
  const bindings = new PiSourceBindings();
  const runtime = options.runtimeFactory(options.plan.runtimeThread);
  const adapter = await options.adapterFactory(runtime, bindings);
  let source: SourceSnapshot | null = null;

  await adapter.replayWithSources(options.plan.inputs, async (snapshot) => {
    installSourceBindings(bindings, snapshot, options.plan.sources);
    source = snapshot;
  });

  if (options.plan.runtimeThread !== options.plan.currentSessionId) {
    source = await adapter.continueNamespace(options.plan.currentSessionId);
    installSourceBindings(bindings, source, options.plan.sources);
    await adapter.previewAndPublish();
  }

  if (source === null) {
    throw new PiSessionRecoveryError("Spine replay returned no source snapshot");
  }
  return { adapter, bindings, source };
}

export function installSourceBindings(
  bindings: PiSourceBindings,
  source: SourceSnapshot,
  observations: readonly PiReplaySource[],
): void {
  if (source.cells.length !== observations.length) {
    throw new PiSessionRecoveryError(
      `Spine source snapshot has ${source.cells.length} cells for ${observations.length} Pi messages`,
    );
  }

  const byBoundary = new Map<number, PiReplaySource>();
  for (const observation of observations) {
    if (byBoundary.has(observation.boundary)) {
      throw new PiSessionRecoveryError(
        `Pi replay has duplicate source boundary ${observation.boundary}`,
      );
    }
    byBoundary.set(observation.boundary, observation);
  }

  bindings.clear();
  for (const cell of source.cells) {
    const observation = byBoundary.get(cell.boundary);
    if (observation === undefined) {
      throw new PiSessionRecoveryError(
        `Spine source cell ${cell.source_id.ordinal} has unknown boundary ${cell.boundary}`,
      );
    }
    bindings.bind(cell.source_id, observation.message, observation.entryId);
  }
}

function decodeArchiveEntry(value: unknown): PiSpineArchiveEntry {
  if (!isRecord(value) || value.schema !== PI_ADAPTER_ID) {
    throw new PiSessionRecoveryError("Pi Spine archive has an invalid adapter schema");
  }
  if (typeof value.durabilityId !== "string" || value.durabilityId.length === 0) {
    throw new PiSessionRecoveryError("Pi Spine archive has no durability ID");
  }
  if (!isRecord(value.record) || !isRecord(value.record.record)) {
    throw new PiSessionRecoveryError("Pi Spine archive has no typed record");
  }
  if (
    value.record.type !== "sampling_started" &&
    value.record.type !== "sampling_commit"
  ) {
    throw new PiSessionRecoveryError("Pi Spine archive has an unknown record type");
  }
  const inner = value.record.record;
  if (
    !isRecord(inner.attempt_id) ||
    typeof inner.attempt_id.thread !== "string" ||
    typeof inner.attempt_id.value !== "string" ||
    inner.attempt_id.value.length === 0
  ) {
    throw new PiSessionRecoveryError("Pi Spine archive identity is inconsistent");
  }
  if (value.record.type === "sampling_commit") {
    if (
      !isRecord(inner.commit_id) ||
      typeof inner.commit_id.value !== "string" ||
      inner.commit_id.value.length === 0
    ) {
      throw new PiSessionRecoveryError("Pi Spine archive identity is inconsistent");
    }
  }
  const record = value.record as SamplingArchiveRecord;
  if (!archiveIdentityMatches(value.durabilityId, record)) {
    throw new PiSessionRecoveryError("Pi Spine archive identity is inconsistent");
  }
  return value as unknown as PiSpineArchiveEntry;
}

function archiveIdentityMatches(
  durabilityId: string,
  record: SamplingArchiveRecord,
): boolean {
  return durabilityId === archiveRecordId(record);
}

function decodeCompactEntry(value: unknown): PiSpineCompactEntry {
  if (
    !isRecord(value) ||
    value.schema !== PI_ADAPTER_ID ||
    !isRecord(value.barrier) ||
    !Array.isArray(value.replacementMessages)
  ) {
    throw new PiSessionRecoveryError("Pi Spine compact entry is malformed");
  }
  if (value.replacementEntryIds !== undefined) {
    if (
      !Array.isArray(value.replacementEntryIds) ||
      value.replacementEntryIds.length !== value.replacementMessages.length
    ) {
      throw new PiSessionRecoveryError(
        "Pi Spine compact replacement entry ids do not match replacement messages",
      );
    }
    for (const entryId of value.replacementEntryIds) {
      if (entryId !== null && (typeof entryId !== "string" || entryId.length === 0)) {
        throw new PiSessionRecoveryError("Pi Spine compact replacement entry id is malformed");
      }
    }
  }
  return value as unknown as PiSpineCompactEntry;
}

function storedEntryId(
  entryIds: readonly (string | null)[] | undefined,
  index: number,
): string | null {
  const entryId = entryIds?.[index];
  return typeof entryId === "string" && entryId.length > 0 ? entryId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
