import type { SpawnArrival, SpawnOutcome, SpawnTask } from "@spinejit/spine-sdk";

// Arrival guards mirror the core's SpawnArrival validation, so a child result
// the core would reject becomes an errored arrival instead of a host fault.
const SPINE_MAX_MEMORY_BYTES = 32 * 1024;
const SPINE_MAX_SUMMARY_BYTES = 4 * 1024;

export interface SpawnChildContext {
  /** The child's birth node id, fixed when its parent's Spawn committed. */
  producer: readonly number[];
  signal: AbortSignal;
  attempt: number;
  mode: "initial" | "continue" | "retry";
  guidance?: string;
}

/** One attempt's end. Only a completed attempt carries model-authored memory. */
export interface SpawnChildTerminal {
  outcome: SpawnOutcome;
  memory?: string | null;
  diagnostic?: string | null;
  executionRef?: string | null;
  /** Host-local recovery capability; never enters the arrival. */
  recovery?: {
    continueable: boolean;
    /** False when a fresh attempt cannot rebuild the birth context, as after a restart. */
    retryable?: boolean;
    reason?: string | null;
  };
}

export interface SpawnExecutor {
  execute(task: SpawnTask, context: SpawnChildContext): Promise<SpawnChildTerminal>;
}

export type SpawnRecoveryAction = "continue" | "retry" | "abandon";

export interface SpawnRecoveryFailure {
  producer: readonly number[];
  task: SpawnTask;
  outcome: Exclude<SpawnOutcome, "completed">;
  diagnostic: string;
  /** Whether reusing this child session is currently evidenced as safe. */
  continueable: boolean;
  retryable: boolean;
  continueReason?: string;
}

export interface SpawnRecoveryDecision {
  action: SpawnRecoveryAction;
  guidance?: string;
}

export interface SpawnRecoveryPolicy {
  choose(failure: SpawnRecoveryFailure, signal: AbortSignal): Promise<SpawnRecoveryDecision | undefined>;
}

export interface RunSpawnChildOptions {
  producer: readonly number[];
  task: SpawnTask;
  executor: SpawnExecutor;
  signal: AbortSignal;
  recovery?: SpawnRecoveryPolicy;
}

/**
 * Runs one spawned child until the recovery policy accepts a final result and
 * returns that result as the child's arrival. An attempt that fails while a
 * decision is pending produces no arrival; cancellation ends as aborted.
 * This layer never synthesizes memory from an exception or transcript.
 */
export async function runSpawnChild(options: RunSpawnChildOptions): Promise<SpawnArrival> {
  let attempt = 0;
  let mode: SpawnChildContext["mode"] = "initial";
  let guidance: string | undefined;
  while (true) {
    let terminal: SpawnChildTerminal;
    try {
      terminal = await options.executor.execute(options.task, {
        producer: options.producer,
        signal: options.signal,
        attempt,
        mode,
        ...(guidance === undefined ? {} : { guidance }),
      });
    } catch (cause) {
      terminal = {
        outcome: options.signal.aborted ? "aborted" : "errored",
        diagnostic: cause instanceof Error ? cause.message : String(cause),
        recovery: { continueable: false, reason: "the child did not start" },
      };
    }
    const arrival = toArrival(options.producer, terminal, options.signal.aborted);
    if (arrival.outcome === "completed" || options.signal.aborted || options.recovery === undefined) {
      return arrival;
    }
    const decision = await options.recovery.choose({
      producer: options.producer,
      task: options.task,
      outcome: arrival.outcome,
      diagnostic: arrival.diagnostic!,
      continueable: terminal.recovery?.continueable ?? true,
      retryable: terminal.recovery?.retryable ?? true,
      ...(terminal.recovery?.reason === undefined || terminal.recovery.reason === null
        ? {}
        : { continueReason: terminal.recovery.reason }),
    }, options.signal);
    if (decision === undefined || decision.action === "abandon" || options.signal.aborted) {
      return arrival;
    }
    guidance = decision.guidance?.trim() || undefined;
    mode = decision.action;
    if (decision.action === "retry") attempt += 1;
  }
}

/** Shapes one attempt's end into an arrival the core accepts. */
export function toArrival(
  producer: readonly number[],
  terminal: SpawnChildTerminal,
  cancelled = false,
): SpawnArrival {
  const executionRef = boundedOrNull(terminal.executionRef);
  const base = { producer: [...producer], ...(executionRef === null ? {} : { execution_ref: executionRef }) };
  const memory = terminal.memory?.trim() ? terminal.memory : null;
  if (terminal.outcome === "completed" && memory !== null) {
    if (utf8ByteLength(memory) <= SPINE_MAX_MEMORY_BYTES) {
      const diagnostic = boundedOrNull(terminal.diagnostic);
      return { ...base, outcome: "completed", memory, ...(diagnostic === null ? {} : { diagnostic }) };
    }
    return {
      ...base,
      outcome: "errored",
      diagnostic: `spawn child memory exceeds ${SPINE_MAX_MEMORY_BYTES} bytes`,
    };
  }
  const outcome = cancelled ? "aborted" : terminal.outcome === "completed" ? "errored" : terminal.outcome;
  const diagnostic = boundedOrNull(terminal.diagnostic)
    ?? (cancelled ? "spawn child was cancelled" : "spawn child ended without typed memory");
  return { ...base, outcome, diagnostic };
}

function boundedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  if (utf8ByteLength(value) <= SPINE_MAX_SUMMARY_BYTES) return value;
  let end = Math.min(value.length, SPINE_MAX_SUMMARY_BYTES);
  while (utf8ByteLength(value.slice(0, end)) > SPINE_MAX_SUMMARY_BYTES) end -= 1;
  return value.slice(0, end);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
