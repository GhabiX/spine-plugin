export const SPINE_SDK_SCHEMA = "spine-sdk/v3" as const;
export const SPINE_SOURCE_SNAPSHOT_SCHEMA = "spine.source.snapshot.v1" as const;

export type SpineSdkSchema = typeof SPINE_SDK_SCHEMA;
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Digest = string;
export type ThreadNamespace = string;
export type SafeInteger = number;

export interface InitRequest {
  schema: SpineSdkSchema;
  thread: ThreadNamespace;
  epoch?: SafeInteger;
  config_toml?: string | null;
  features?: FeatureFlag[];
}

export type FeatureFlag = "jit" | "spawn";
export type Terminal = "completed" | "failed" | "cancelled";
export type SourceRole =
  | "user"
  | "contextual_user"
  | "assistant"
  | "reply"
  | "developer"
  | "system";
export type MessageRole =
  | "User"
  | "ContextualUser"
  | "Assistant"
  | "Reply"
  | "Developer"
  | "System";

export interface EpochOrdinalId {
  thread: ThreadNamespace;
  epoch: SafeInteger;
  ordinal: SafeInteger;
}

export interface NamespacedId {
  thread: ThreadNamespace;
  value: string;
}

export interface Message {
  boundary: SafeInteger;
  role: MessageRole;
  content: string;
}

export interface RawSpan {
  start: SafeInteger;
  end: SafeInteger;
}

export interface SpawnTask {
  summary: string;
  prompt: string;
}

export type SpawnOutcome = "completed" | "errored" | "aborted";

/**
 * Join state of a spawned child: pending until its arrival is admitted;
 * inherited when it was born in an earlier namespace, which alone joins it.
 */
export type SpawnState = "pending" | "inherited" | { arrived: SpawnOutcome };

/** A spawned child's final result. Completed carries memory; others carry a diagnostic. */
export interface SpawnArrival {
  producer: SafeInteger[];
  outcome: SpawnOutcome;
  memory?: string | null;
  diagnostic?: string | null;
  execution_ref?: string | null;
}

export type MemorySlot =
  | {
      User: {
        owner_node: SafeInteger[];
        message: Message;
        anchor: SafeInteger;
      };
    }
  | {
      Summary: {
        owner_node: SafeInteger[];
        source: RawSpan;
        body: string;
      };
    }
  | {
      Birth: {
        owner_node: SafeInteger[];
        source: RawSpan;
        task: SpawnTask;
      };
    }
  | {
      Arrival: {
        owner_node: SafeInteger[];
        boundary: SafeInteger;
        arrival: SpawnArrival;
      };
    }
  | {
      Reply: {
        owner_node: SafeInteger[];
        message: Message;
      };
    };

export type ContextItem =
  | { Message: { message: Message; user_anchor: SafeInteger | null } }
  | { SourceSpan: { span: RawSpan } }
  | {
      SyntheticNode: {
        node_id: SafeInteger[];
        summary: string;
        status: "Live" | "Opened" | "Closed" | "Compacted";
      };
    }
  | { MemorySlot: MemorySlot }
  | {
      Native:
        | { source: { Rollout: { ordinal: SafeInteger } } }
        | {
            source: {
              CompactReplacement: {
                compact_boundary: SafeInteger;
                index: SafeInteger;
              };
            };
          };
    };

export type SourceCharacter =
  | {
      type: "message";
      boundary: SafeInteger;
      role: SourceRole;
      content: string;
    }
  | { type: "opaque"; boundary: SafeInteger }
  | { type: "synthetic"; boundary: SafeInteger; item: ContextItem }
  | { type: "arrival"; boundary: SafeInteger; arrival: SpawnArrival };

export type SpineOperation =
  | { type: "open"; summary: string }
  | { type: "close"; memory: string }
  | { type: "next"; closed_memory: string; next_summary: string }
  | { type: "spawn"; tasks: SpawnTask[] };

export interface SamplingStarted {
  schema: "spine.sampling.started";
  attempt_id: NamespacedId;
  epoch: SafeInteger;
  pre_boundary: EpochOrdinalId;
  previous_commit_id: NamespacedId | null;
  prompt_digest?: Digest;
  source_digest?: Digest;
  record_digest?: Digest;
}

export interface CommittedSpineExecution {
  execution_id: NamespacedId;
  ordinal: SafeInteger;
  origin: { type: "direct"; execution_ref: string };
  source_span: { start: EpochOrdinalId; end: EpochOrdinalId };
  operation: SpineOperation;
}

export interface SamplingCommit {
  schema: "spine.sampling.commit";
  attempt_id: NamespacedId;
  started_record_digest?: Digest;
  commit_id: NamespacedId;
  epoch: SafeInteger;
  previous_pre_boundary: EpochOrdinalId | null;
  pre_boundary: EpochOrdinalId;
  post_boundary: EpochOrdinalId;
  previous_commit_id: NamespacedId | null;
  input_tokens?: SafeInteger;
  executions: CommittedSpineExecution[];
  source_digest?: Digest;
  record_digest?: Digest;
}

export type SamplingArchiveRecord =
  | { type: "sampling_started"; record: SamplingStarted }
  | { type: "sampling_commit"; record: SamplingCommit };

export type ContextPlanCell =
  | {
      type: "source";
      source_id: EpochOrdinalId;
      labels: Array<{ UserAnchor: SafeInteger }>;
    }
  | {
      type: "projection";
      projection_id: EpochOrdinalId;
      item: ContextItem;
    };

export interface ContextPlanRecipe {
  schema: "spine.context.plan.v2";
  thread: ThreadNamespace;
  epoch: SafeInteger;
  source_snapshot_digest?: Digest;
  cells: ContextPlanCell[];
  plan_digest?: Digest;
}

export interface SourceBinding {
  source_id: EpochOrdinalId;
  boundary: SafeInteger;
  item: ContextItem;
}

export interface SourceSnapshot {
  schema: typeof SPINE_SOURCE_SNAPSHOT_SCHEMA;
  thread: ThreadNamespace;
  epoch: SafeInteger;
  cells: SourceBinding[];
}

export interface NodeSnapshot {
  id: SafeInteger[];
  parent: SafeInteger[] | null;
  children: SafeInteger[][];
  kind: "RootEpoch" | "Task" | "Spawn";
  status: "Live" | "Opened" | "Closed" | "Compacted";
  summary: string | null;
  memory: MemorySlot[] | null;
  /** For a Spawn node, its join state; null for other kinds. */
  spawn: SpawnState | null;
  start: SafeInteger;
  end: SafeInteger | null;
}

export interface SpineProjection {
  nodes: NodeSnapshot[];
  cursor: SafeInteger[];
  visible_context: ContextItem[];
  last_boundary: SafeInteger | null;
}

export interface CompactBarrier {
  schema: "spine.compact.barrier.v1";
  thread: ThreadNamespace;
  previous_epoch: SafeInteger;
  next_epoch: SafeInteger;
  boundary: SafeInteger;
  replacement_boundaries: SafeInteger[];
  replacement_digest?: Digest;
}

export type ReplayItem =
  | { type: "source"; character: SourceCharacter }
  | { type: "archive"; record: SamplingArchiveRecord }
  | { type: "compact"; barrier: CompactBarrier }
  | { type: "usage"; boundary: SafeInteger; input_tokens: SafeInteger };

export type Command =
  | { type: "observe_sources"; characters: SourceCharacter[] }
  | { type: "begin_sampling"; prompt_digest?: Digest }
  | { type: "register_execution"; key: string }
  | {
      type: "stage_execution";
      key: string;
      execution_ref: string;
      operation: SpineOperation;
    }
  | { type: "finish_execution"; key: string; succeeded: boolean }
  | {
      type: "prepare_finish";
      terminal: Terminal;
      input_tokens?: SafeInteger;
    }
  | { type: "install_prepared"; transaction_id: string }
  | { type: "discard_prepared"; transaction_id: string }
  | { type: "compact"; barrier: CompactBarrier }
  | { type: "preview" }
  | { type: "source_snapshot" }
  | { type: "continue_namespace"; thread: ThreadNamespace }
  | { type: "replay"; inputs: ReplayItem[] }
  | { type: "replay_begin" }
  | { type: "replay_apply"; inputs: ReplayItem[] }
  | { type: "replay_finish" };

export interface CommandRequest {
  schema: SpineSdkSchema;
  request: Command;
}

export type CommandResult =
  | { type: "sources_observed"; source_ids: EpochOrdinalId[] }
  | { type: "sampling_started"; record: SamplingArchiveRecord }
  | { type: "execution_registered" }
  | { type: "execution_staged" }
  | { type: "execution_finished" }
  | {
      type: "finish_prepared";
      transaction_id: string;
      record: SamplingArchiveRecord;
      context_plan: ContextPlanRecipe;
      projection: SpineProjection;
    }
  | { type: "sampling_orphaned" }
  | {
      type: "prepared_installed";
      transaction_id: string;
      context_plan: ContextPlanRecipe;
      projection: SpineProjection;
    }
  | { type: "prepared_discarded"; transaction_id: string }
  | {
      type: "compacted";
      context_plan: ContextPlanRecipe;
      projection: SpineProjection;
    }
  | {
      type: "preview";
      context_plan: ContextPlanRecipe;
      projection: SpineProjection;
    }
  | { type: "source_snapshot"; source: SourceSnapshot }
  | { type: "namespace_continued"; source: SourceSnapshot }
  | { type: "replay_begun" }
  | { type: "replay_applied" }
  | {
      type: "replay_installed";
      context_plan: ContextPlanRecipe | null;
      projection: SpineProjection;
      applied_commits: NamespacedId[];
      source: SourceSnapshot;
    };

export interface BindingError {
  code: string;
  message: string;
}

export type ResponseEnvelope =
  | { schema: SpineSdkSchema; ok: true; result: CommandResult }
  | { schema: SpineSdkSchema; ok: false; error: BindingError };

const RESULT_TYPES = new Set<CommandResult["type"]>([
  "sources_observed",
  "sampling_started",
  "execution_registered",
  "execution_staged",
  "execution_finished",
  "finish_prepared",
  "sampling_orphaned",
  "prepared_installed",
  "prepared_discarded",
  "compacted",
  "preview",
  "source_snapshot",
  "namespace_continued",
  "replay_begun",
  "replay_applied",
  "replay_installed",
]);

export class SpineProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpineProtocolError";
    this.code = code;
  }
}

export function encodeCommand(command: Command): string {
  assertSafeIntegers(command);
  return JSON.stringify({ schema: SPINE_SDK_SCHEMA, request: command });
}

export function encodeInit(init: Omit<InitRequest, "schema">): string {
  const request: InitRequest = { schema: SPINE_SDK_SCHEMA, ...init };
  assertSafeIntegers(request);
  return JSON.stringify(request);
}

export function decodeResponse(encoded: string): ResponseEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new SpineProtocolError("invalid_json", String(error));
  }
  if (!isRecord(value) || value.schema !== SPINE_SDK_SCHEMA || typeof value.ok !== "boolean") {
    throw new SpineProtocolError("invalid_envelope", "invalid Spine SDK response envelope");
  }
  if (value.ok) {
    if (!isRecord(value.result) || typeof value.result.type !== "string" || !RESULT_TYPES.has(value.result.type as CommandResult["type"])) {
      throw new SpineProtocolError("invalid_result", "invalid Spine SDK result");
    }
  } else if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    throw new SpineProtocolError("invalid_error", "invalid Spine SDK error");
  }
  assertSafeIntegers(value);
  return value as ResponseEnvelope;
}

export function assertSafeIntegers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new SpineProtocolError("unsafe_integer", `${path} must be a safe integer`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeIntegers(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertSafeIntegers(item, `${path}.${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
