
import type {
  SourceSnapshot,
  SpawnResult,
  SpawnTask,
  Terminal,
} from "@spinejit/spine-sdk";

import type { SpineHostAdapter } from "../host-adapter.js";
import {
  decodeSpineSpawnTasks,
  isSpineToolName,
  operationFromSpineToolCall,
} from "../tools.js";
import {
  DeepSeekHarnessSourceBindings,
  observeDeepSeekHarnessMessage,
  type DeepSeekHarnessMessage,
} from "./messages.js";

export interface DeepSeekHarnessToolStart {
  callId: string;
  name: string;
  arguments: unknown;
}

export class DeepSeekHarnessLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekHarnessLifecycleError";
  }
}

/** Owns one DSH step-to-Spine sampling transaction at a time. */
export class DeepSeekHarnessSamplingLifecycle {
  readonly #adapter: SpineHostAdapter;
  readonly #bindings: DeepSeekHarnessSourceBindings;
  readonly #executions = new Set<string>();
  #nextBoundary: number;
  #samplingActive = false;
  #successfulStepPending = false;
  #inputTokens: number | undefined;
  #fault: unknown = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    adapter: SpineHostAdapter,
    bindings: DeepSeekHarnessSourceBindings,
    source: SourceSnapshot,
  ) {
    this.#adapter = adapter;
    this.#bindings = bindings;
    this.#nextBoundary = nextSourceBoundary(source);
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  enqueueMessage(message: DeepSeekHarnessMessage, inputTokens?: number): void {
    this.#enqueue(async () => {
      const observation = observeDeepSeekHarnessMessage(message, this.#nextBoundary);
      const admitted = await this.#adapter.observeSources([observation.character]);
      const sourceId = admitted[0];
      if (admitted.length !== 1 || sourceId === undefined) {
        throw new DeepSeekHarnessLifecycleError(
          `Spine admitted ${admitted.length} source IDs for one DSH message`,
        );
      }
      this.#bindings.bind(sourceId, observation.message);
      this.#nextBoundary += 1;
      if (inputTokens !== undefined) this.#inputTokens = inputTokens;
    });
  }

  enqueueToolStart(start: DeepSeekHarnessToolStart): boolean {
    if (!isSpineToolName(start.name)) return false;
    const toolName = start.name;
    this.#enqueue(async () => {
      this.#assertSamplingActive();
      if (this.#executions.has(start.callId)) {
        throw new DeepSeekHarnessLifecycleError(`duplicate DSH Spine tool call ${start.callId}`);
      }
      const input = decodeToolInput(start.arguments);
      const operation = toolName === "spine_spawn"
        ? null
        : operationFromSpineToolCall(toolName, input);
      if (toolName === "spine_spawn") decodeSpineSpawnTasks(input);
      await this.#adapter.registerExecution(start.callId);
      this.#executions.add(start.callId);
      if (operation !== null) {
        await this.#adapter.stageExecution(
          start.callId,
          start.callId,
          operation,
        );
      }
    });
    return true;
  }

  enqueueToolFinish(callId: string, succeeded: boolean): boolean {
    this.#enqueue(async () => {
      if (!this.#executions.has(callId)) return;
      await this.#adapter.finishExecution(callId, succeeded);
      this.#executions.delete(callId);
    });
    return true;
  }

  stageSpawn(
    callId: string,
    tasks: readonly SpawnTask[],
    results: readonly SpawnResult[],
  ): Promise<void> {
    return this.#serialize(async () => {
      this.#assertSamplingActive();
      if (!this.#executions.has(callId)) {
        throw new DeepSeekHarnessLifecycleError(`unknown DSH Spine Spawn call ${callId}`);
      }
      await this.#adapter.stageExecution(callId, callId, {
        type: "spawn",
        tasks: [...tasks],
        terminal_results: [...results],
      });
    });
  }

  async beginSampling(_request: unknown): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      if (this.#samplingActive) {
        throw new DeepSeekHarnessLifecycleError("DSH began a request before the prior step ended");
      }
      await this.#adapter.beginSampling();
      this.#samplingActive = true;
      this.#inputTokens = undefined;
      this.#successfulStepPending = false;
      this.#executions.clear();
    });
  }

  enqueueSuccessfulStepEnd(): void {
    this.#enqueue(async () => {
      if (this.#samplingActive) this.#successfulStepPending = true;
    });
  }

  async finishPendingSuccess(): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      if (this.#successfulStepPending) await this.#finish("completed");
    });
  }

  enqueueFinish(terminal: Terminal): void {
    this.#enqueue(async () => {
      this.#successfulStepPending = false;
      await this.#finish(terminal);
    });
  }

  violate(cause: unknown): void {
    this.#enqueue(() => Promise.reject(cause));
  }

  async finishNow(terminal: Terminal): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      this.#successfulStepPending = false;
      await this.#finish(terminal);
    });
  }

  async drain(): Promise<void> {
    await this.#tail;
    this.#assertHealthy();
  }

  dispose(): void {
    this.#adapter.dispose();
  }

  async #finish(terminal: Terminal): Promise<void> {
    if (!this.#samplingActive) return;
    if (this.#executions.size !== 0) {
      throw new DeepSeekHarnessLifecycleError(
        `DSH sampling ended with unfinished Spine executions: ${[...this.#executions].join(", ")}`,
      );
    }
    await this.#adapter.finishSampling(terminal, this.#inputTokens);
    this.#samplingActive = false;
    this.#successfulStepPending = false;
    this.#inputTokens = undefined;
  }

  #enqueue(operation: () => Promise<void>): void {
    this.#tail = this.#tail.then(() => this.#guard(operation));
    void this.#tail.catch(() => undefined);
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await this.#guard(operation);
    } finally {
      release();
    }
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertHealthy();
    try {
      return await operation();
    } catch (cause) {
      this.#fault ??= cause;
      throw new DeepSeekHarnessLifecycleError("DSH Spine lifecycle fault", { cause });
    }
  }

  #assertHealthy(): void {
    if (this.fault !== null) {
      throw new DeepSeekHarnessLifecycleError("DSH Spine lifecycle is faulted", {
        cause: this.fault,
      });
    }
  }

  #assertSamplingActive(): void {
    if (!this.#samplingActive) {
      throw new DeepSeekHarnessLifecycleError("DSH Spine operation occurred outside sampling");
    }
  }
}

function decodeToolInput(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch (cause) {
      throw new DeepSeekHarnessLifecycleError("DSH Spine tool arguments are not JSON", { cause });
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeepSeekHarnessLifecycleError("DSH Spine tool arguments are not an object");
  }
  return value as Record<string, unknown>;
}

function nextSourceBoundary(source: SourceSnapshot): number {
  return source.cells.reduce((next, cell) => Math.max(next, cell.boundary + 1), 0);
}
