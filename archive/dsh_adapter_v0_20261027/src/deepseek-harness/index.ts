import {
  assertSafeIntegers,
  type JsonValue,
  type SamplingArchiveRecord,
  type SpawnResult,
  type SpawnTask,
  type SpineRuntimeClient,
} from "@spinejit/spine-sdk";

import {
  createHostAdapter,
  type HostContextEnvelope,
  type HostOwnershipClaim,
  type PublishedContext,
  type SpawnStagingStore,
  type SpineHostAdapter,
} from "../index.js";
import { recoverStagedSpawnResults } from "../spawn.js";

export * from "./lifecycle.js";
export * from "./messages.js";
export * from "./recovery.js";

export * from "./messages.js";
export * from "./recovery.js";

export const DEEPSEEK_HARNESS_ADAPTER_ID = "spine-plugin/deepseek-harness/v1" as const;
export const DEEPSEEK_HARNESS_EVENT_OWNER = "spine" as const;
export const DEEPSEEK_HARNESS_ARCHIVE_EVENT = "spine/archive" as const;
export const DEEPSEEK_HARNESS_SURFACE_EVENT = "surface/projection" as const;
export const DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT = "spine/spawn-terminal" as const;

export interface DeepSeekHarnessEventManifest {
  owner: typeof DEEPSEEK_HARNESS_EVENT_OWNER;
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  events: Readonly<{
    [DEEPSEEK_HARNESS_ARCHIVE_EVENT]: DeepSeekHarnessRequiredEventCodec;
    [DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT]: DeepSeekHarnessRequiredEventCodec;
  }>;
}

export interface DeepSeekHarnessRequiredEventCodec {
  decode(data: JsonValue): void;
}

export interface DeepSeekHarnessArchiveEvent {
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  durabilityId: string;
  record: SamplingArchiveRecord;
}

export interface DeepSeekHarnessSpawnTerminalEvent {
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  batchId: string;
  result: SpawnResult;
}

export interface DeepSeekHarnessSpinePort<TMessage> {
  registerRequiredEventOwner?(manifest: DeepSeekHarnessEventManifest): () => void;
  claimOwnership(claim: HostOwnershipClaim): Promise<void>;
  appendRequiredEvent(
    type: typeof DEEPSEEK_HARNESS_ARCHIVE_EVENT,
    event: DeepSeekHarnessArchiveEvent,
  ): Promise<void>;
  appendRequiredEvent(
    type: typeof DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT,
    event: DeepSeekHarnessSpawnTerminalEvent,
  ): Promise<void>;
  materializeContext(context: PublishedContext): Promise<readonly TMessage[]>;
  publishAtomicSurface?(
    context: HostContextEnvelope<TMessage>,
  ): Promise<void>;
}

export interface DeepSeekHarnessSurface {
  readonly nodes: readonly number[];
  readonly replaceGeneration: number;
}

export interface DeepSeekHarnessSession<TMessage> {
  readonly events: readonly DeepSeekHarnessSessionEvent[];
  readonly surface: DeepSeekHarnessSurface;
  append(type: typeof DEEPSEEK_HARNESS_ARCHIVE_EVENT, data: DeepSeekHarnessArchiveEvent): unknown;
  append(type: typeof DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT, data: DeepSeekHarnessSpawnTerminalEvent): unknown;
  append(
    type: typeof DEEPSEEK_HARNESS_ARCHIVE_EVENT | typeof DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT,
    data: DeepSeekHarnessArchiveEvent | DeepSeekHarnessSpawnTerminalEvent,
  ): unknown;
  append(type: typeof DEEPSEEK_HARNESS_SURFACE_EVENT, data: DeepSeekHarnessSurfaceProjection<TMessage>): unknown;
}

export interface DeepSeekHarnessSessionEvent {
  readonly type: string;
  readonly data: unknown;
}

export interface DeepSeekHarnessSessionStore<TMessage> {
  registerRequiredEventOwner(manifest: DeepSeekHarnessEventManifest): () => void;
  flush(session: DeepSeekHarnessSession<TMessage>): Promise<boolean>;
}

export interface DeepSeekHarnessSurfaceProjection<TMessage> {
  owner: typeof DEEPSEEK_HARNESS_EVENT_OWNER;
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  expectedGeneration: number;
  planDigest: string;
  provenance: number[];
  messages: TMessage[];
  payload: JsonValue;
}

export interface CreateDeepSeekHarnessSessionPortOptions<TMessage> {
  session: DeepSeekHarnessSession<TMessage>;
  sessions: DeepSeekHarnessSessionStore<TMessage>;
  claimOwnership(claim: HostOwnershipClaim): Promise<void>;
  materializeContext(context: PublishedContext): Promise<readonly TMessage[]>;
  registerRequiredEventOwner?(manifest: DeepSeekHarnessEventManifest): () => void;
}

export class DeepSeekHarnessDurabilityError extends Error {
  constructor() {
    super("DeepSeek Harness has no session durability listener for the Spine session");
    this.name = "DeepSeekHarnessDurabilityError";
  }
}

export function createDeepSeekHarnessSessionPort<TMessage>(
  options: CreateDeepSeekHarnessSessionPortOptions<TMessage>,
): DeepSeekHarnessSpinePort<TMessage> {
  const flush = async (): Promise<void> => {
    if (!await options.sessions.flush(options.session)) {
      throw new DeepSeekHarnessDurabilityError();
    }
  };
  return {
    registerRequiredEventOwner: (manifest) =>
      (options.registerRequiredEventOwner ?? ((owner) =>
        options.sessions.registerRequiredEventOwner(owner)))(manifest),
    claimOwnership: async (claim) => {
      await options.claimOwnership(claim);
      await flush();
    },
    appendRequiredEvent: async (type, event) => {
      options.session.append(type, event);
      await flush();
    },
    materializeContext: (context) => options.materializeContext(context),
    publishAtomicSurface: async (context) => {
      if (context.contextPlan === null && context.messages.length === 0 && options.session.surface.nodes.length === 0) {
        return;
      }
      options.session.append(DEEPSEEK_HARNESS_SURFACE_EVENT, {
        owner: DEEPSEEK_HARNESS_EVENT_OWNER,
        schema: DEEPSEEK_HARNESS_ADAPTER_ID,
        expectedGeneration: options.session.surface.replaceGeneration,
        planDigest: context.contextPlan === null
          ? "spine.context.plan"
          : `${context.contextPlan.thread}:${context.contextPlan.epoch}:${context.contextPlan.cells.length}`,
        provenance: [...options.session.surface.nodes],
        messages: [...context.messages],
        payload: assertJsonValue(context),
      });
      await flush();
    },
  };
}

export function createDeepSeekHarnessEventOwnerLeases(
  register: (manifest: DeepSeekHarnessEventManifest) => () => void,
): (manifest: DeepSeekHarnessEventManifest) => () => void {
  let active: { manifest: DeepSeekHarnessEventManifest; dispose: () => void; leases: number } | null = null;
  return (manifest) => {
    if (active === null) {
      active = { manifest, dispose: register(manifest), leases: 0 };
    } else if (!sameManifest(active.manifest, manifest)) {
      throw new Error("inconsistent DeepSeek Harness Spine required-event manifest");
    }
    const registration = active;
    registration.leases += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      registration.leases -= 1;
      if (registration.leases === 0 && active === registration) {
        active = null;
        registration.dispose();
      }
    };
  };
}

export function createDeepSeekHarnessSpawnStagingStore<TMessage>(
  host: DeepSeekHarnessSpinePort<TMessage>,
): SpawnStagingStore {
  return {
    persistTerminal: (batchId, result) =>
      host.appendRequiredEvent(DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT, {
        schema: DEEPSEEK_HARNESS_ADAPTER_ID,
        batchId,
        result,
      }),
  };
}

export function recoverDeepSeekHarnessSpawnResults(
  events: readonly DeepSeekHarnessSessionEvent[],
  batchId: string,
  tasks: readonly SpawnTask[],
): SpawnResult[] {
  const staged = events
    .filter((event) => event.type === DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT)
    .map((event) => decodeSpawnTerminalEvent(event.data))
    .filter((event) => event.batchId === batchId)
    .map((event) => event.result);
  return recoverStagedSpawnResults(tasks, staged);
}

export interface DeepSeekHarnessSpineAdapterOptions<TMessage> {
  enabled: boolean;
  runtime: SpineRuntimeClient;
  host: DeepSeekHarnessSpinePort<TMessage>;
}

export class DeepSeekHarnessCapabilityError extends Error {
  readonly capability: "required-event-owner" | "atomic-surface-projection";

  constructor(capability: DeepSeekHarnessCapabilityError["capability"]) {
    super(`DeepSeek Harness does not provide required Spine capability: ${capability}`);
    this.name = "DeepSeekHarnessCapabilityError";
    this.capability = capability;
  }
}

export async function createDeepSeekHarnessSpineAdapter<TMessage>(
  options: DeepSeekHarnessSpineAdapterOptions<TMessage>,
): Promise<SpineHostAdapter | null> {
  if (!options.enabled) {
    return null;
  }
  const registerRequiredEventOwner = options.host.registerRequiredEventOwner;
  if (registerRequiredEventOwner === undefined) {
    throw new DeepSeekHarnessCapabilityError("required-event-owner");
  }
  const publishAtomicSurface = options.host.publishAtomicSurface;
  if (publishAtomicSurface === undefined) {
    throw new DeepSeekHarnessCapabilityError("atomic-surface-projection");
  }

  const unregister = registerRequiredEventOwner.call(options.host, {
    owner: DEEPSEEK_HARNESS_EVENT_OWNER,
    schema: DEEPSEEK_HARNESS_ADAPTER_ID,
    events: {
      [DEEPSEEK_HARNESS_ARCHIVE_EVENT]: { decode: decodeArchiveEvent },
      [DEEPSEEK_HARNESS_SPAWN_TERMINAL_EVENT]: { decode: decodeSpawnTerminalEvent },
    },
  });

  try {
    return await createHostAdapter({
      runtime: options.runtime,
      dispose: unregister,
      host: {
        claimOwnership: (claim) => options.host.claimOwnership(claim),
        persistArchive: (entry) =>
          options.host.appendRequiredEvent(DEEPSEEK_HARNESS_ARCHIVE_EVENT, {
            schema: DEEPSEEK_HARNESS_ADAPTER_ID,
            durabilityId: entry.durabilityId,
            record: entry.record,
          }),
        context: {
          materialize: (context) => options.host.materializeContext(context),
          publishAtomic: (context) => publishAtomicSurface.call(options.host, context),
        },
      },
    });
  } catch (error) {
    unregister();
    throw error;
  }
}

function decodeArchiveEvent(data: JsonValue): void {
  if (!isRecord(data) || data.schema !== DEEPSEEK_HARNESS_ADAPTER_ID) {
    throw new Error("invalid Spine archive schema");
  }
  if (typeof data.durabilityId !== "string" || data.durabilityId.length === 0) {
    throw new Error("invalid Spine archive durability identity");
  }
  if (!isRecord(data.record) || !isRecord(data.record.record)) {
    throw new Error("invalid Spine archive record");
  }
  if (data.record.type !== "sampling_started" && data.record.type !== "sampling_commit") {
    throw new Error("unknown Spine archive record type");
  }
  const record = data.record.record;
  if (
    !isRecord(record.attempt_id) ||
    typeof record.attempt_id.thread !== "string" ||
    record.attempt_id.thread.length === 0
  ) {
    throw new Error("inconsistent Spine archive identity");
  }
  if (data.record.type === "sampling_started") {
    assertSamplingStarted(record);
  } else {
    assertSamplingCommit(record);
  }
  assertSafeIntegers(data);
}

function assertSamplingStarted(record: Record<string, unknown>): void {
  if (
    record.schema !== "spine.sampling.started" ||
    !isNonNegativeInteger(record.epoch) ||
    !isEpochOrdinalId(record.pre_boundary) ||
    !isNamespacedId(record.attempt_id) ||
    !isNullableNamespacedId(record.previous_commit_id)
  ) {
    throw new Error("malformed Spine sampling-started record");
  }
}

function assertSamplingCommit(record: Record<string, unknown>): void {
  if (
    record.schema !== "spine.sampling.commit" ||
    !isNamespacedId(record.attempt_id) ||
    !isNamespacedId(record.commit_id) ||
    !isNonNegativeInteger(record.epoch) ||
    !(record.previous_pre_boundary === null || isEpochOrdinalId(record.previous_pre_boundary)) ||
    !isEpochOrdinalId(record.pre_boundary) ||
    !isEpochOrdinalId(record.post_boundary) ||
    !isNullableNamespacedId(record.previous_commit_id) ||
    !Array.isArray(record.executions)
  ) {
    throw new Error("malformed Spine sampling-commit record");
  }
  if (record.input_tokens !== undefined && !isNonNegativeInteger(record.input_tokens)) {
    throw new Error("malformed Spine sampling-commit input token count");
  }
  for (const execution of record.executions) assertCommittedExecution(execution);
}

function assertCommittedExecution(value: unknown): void {
  if (!isRecord(value)) throw new Error("malformed committed Spine execution");
  if (
    !isNamespacedId(value.execution_id) ||
    !isNonNegativeInteger(value.ordinal) ||
    !isRecord(value.origin) ||
    value.origin.type !== "direct" ||
    !isNonEmptyString(value.origin.execution_ref) ||
    !isRecord(value.source_span) ||
    !isEpochOrdinalId(value.source_span.start) ||
    !isEpochOrdinalId(value.source_span.end) ||
    !isRecord(value.operation)
  ) {
    throw new Error("malformed committed Spine execution");
  }
  assertSpineOperation(value.operation);
}

function assertSpineOperation(operation: Record<string, unknown>): void {
  switch (operation.type) {
    case "open":
      if (!isNonEmptyString(operation.summary)) throw new Error("malformed Spine Open operation");
      return;
    case "close":
      if (!isNonEmptyString(operation.memory)) throw new Error("malformed Spine Close operation");
      return;
    case "next":
      if (!isNonEmptyString(operation.closed_memory) || !isNonEmptyString(operation.next_summary)) {
        throw new Error("malformed Spine Next operation");
      }
      return;
    case "spawn":
      if (!Array.isArray(operation.tasks) || !Array.isArray(operation.terminal_results)) {
        throw new Error("malformed Spine Spawn operation");
      }
      for (const task of operation.tasks) {
        if (!isRecord(task) || !isNonEmptyString(task.summary) || !isNonEmptyString(task.prompt)) {
          throw new Error("malformed Spine Spawn task");
        }
      }
      for (const result of operation.terminal_results) {
        decodeSpawnTerminalEvent({
          schema: DEEPSEEK_HARNESS_ADAPTER_ID,
          batchId: "archive-validation",
          result,
        });
      }
      return;
    default:
      throw new Error("unknown Spine operation type");
  }
}

function decodeSpawnTerminalEvent(data: unknown): DeepSeekHarnessSpawnTerminalEvent {
  if (
    !isRecord(data) ||
    data.schema !== DEEPSEEK_HARNESS_ADAPTER_ID ||
    typeof data.batchId !== "string" ||
    data.batchId.length === 0 ||
    !isRecord(data.result)
  ) {
    throw new Error("malformed Spine Spawn terminal staging");
  }
  const result = data.result;
  if (
    !Number.isSafeInteger(result.ordinal) ||
    (result.ordinal as number) < 0 ||
    (result.outcome !== "completed" && result.outcome !== "errored" && result.outcome !== "aborted") ||
    typeof result.memory_body !== "string" ||
    result.memory_body.trim().length === 0
  ) {
    throw new Error("invalid Spine Spawn terminal result");
  }
  if (
    result.outcome !== "completed" &&
    (typeof result.diagnostic !== "string" || result.diagnostic.trim().length === 0)
  ) {
    throw new Error("non-completed Spine Spawn terminal requires a diagnostic");
  }
  if (
    result.execution_ref !== undefined &&
    result.execution_ref !== null &&
    (typeof result.execution_ref !== "string" || result.execution_ref.trim().length === 0)
  ) {
    throw new Error("invalid Spine Spawn execution reference");
  }
  assertSafeIntegers(data);
  return data as unknown as DeepSeekHarnessSpawnTerminalEvent;
}

function assertJsonValue(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new Error("Spine context envelope contains a non-lossless JSON number");
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error("Spine context envelope is not lossless JSON");
    }
    if (ancestors.has(candidate)) {
      throw new Error("Spine context envelope contains a cycle");
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.hasOwn(candidate, index)) {
          throw new Error("Spine context envelope contains a sparse array");
        }
        visit(candidate[index]);
      }
    } else {
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Spine context envelope contains a non-plain object");
      }
      for (const item of Object.values(candidate)) visit(item);
    }
    ancestors.delete(candidate);
  };
  visit(value);
  return value as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameManifest(
  left: DeepSeekHarnessEventManifest,
  right: DeepSeekHarnessEventManifest,
): boolean {
  return left.owner === right.owner &&
    left.schema === right.schema &&
    Object.keys(left.events).sort().join("\u0000") === Object.keys(right.events).sort().join("\u0000");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNamespacedId(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.thread) && isNonEmptyString(value.value);
}

function isNullableNamespacedId(value: unknown): boolean {
  return value === null || isNamespacedId(value);
}

function isEpochOrdinalId(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.thread) &&
    isNonNegativeInteger(value.epoch) &&
    isNonNegativeInteger(value.ordinal);
}
