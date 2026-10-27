import { createNodeSpineRuntime, type NodeSpineRuntime } from "@spinejit/spine-sdk/node";
import type { SpawnTask } from "@spinejit/spine-sdk";

import { executeSpawnBatch, type SpawnChildTerminal } from "../spawn.js";
import {
  decodeSpineSpawnTasks,
  SPINE_TOOL_NAMES,
  type SpineToolName,
} from "../tools.js";
import {
  createDeepSeekHarnessEventOwnerLeases,
  createDeepSeekHarnessSessionPort,
  createDeepSeekHarnessSpawnStagingStore,
  createDeepSeekHarnessSpineAdapter,
  type DeepSeekHarnessEventManifest,
  type DeepSeekHarnessSession,
  type DeepSeekHarnessSessionEvent,
  type DeepSeekHarnessSessionStore,
  type DeepSeekHarnessSpinePort,
} from "./index.js";
import {
  DeepSeekHarnessSamplingLifecycle,
  type DeepSeekHarnessToolStart,
} from "./lifecycle.js";
import {
  materializeDeepSeekHarnessContext,
  type DeepSeekHarnessMessage,
  type DeepSeekHarnessSourceBindings,
} from "./messages.js";
import {
  buildDeepSeekHarnessReplayPlan,
  recoverDeepSeekHarnessSession,
} from "./recovery.js";

export const name = "spine";
export const inject = ["agents", "llm", "sessions", "subagents", "tools"];

export interface Config {
  enabled?: boolean;
  configToml?: string;
  spawnProvider?: string;
}

interface DshAgent {
  readonly session: DshSession;
}

interface DshSession extends DeepSeekHarnessSession<DeepSeekHarnessMessage> {
  readonly id: string;
}

interface DshToolExecution {
  readonly callId: string;
  readonly arguments: unknown;
  readonly agent?: DshAgent;
  readonly signal: AbortSignal;
}

interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  execute(args: Record<string, unknown>, exec: DshToolExecution): Promise<unknown>;
}

interface DshSubagentRun {
  readonly id: string;
  readonly result: Promise<{
    structured?: unknown;
    stopReason: string;
  }>;
  dispose(): Promise<void>;
}

interface DshContext {
  sessions: DeepSeekHarnessSessionStore<DeepSeekHarnessMessage>;
  tools: { register(tool: DshToolDefinition): () => void };
  subagents: {
    start(provider: string, request: any): Promise<DshSubagentRun>;
  };
  get(name: string): unknown;
  on(name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void;
  effect(effect: () => () => void | Promise<void>, label?: string): unknown;
}

interface SessionState {
  lifecycle: DeepSeekHarnessSamplingLifecycle;
  runtime: NodeSpineRuntime;
  port: DeepSeekHarnessSpinePort<DeepSeekHarnessMessage>;
}

const MEMORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memory"],
  properties: {
    memory: { type: "string", minLength: 1 },
  },
} as const;

export function apply(ctx: DshContext, config: Config = {}): void {
  if (config.enabled === false) return;
  if (ctx.get("compaction") !== undefined) {
    throw new Error("Spine requires exclusive compaction ownership; remove the DSH compaction provider");
  }
  const spawnProvider = nonEmpty(config.spawnProvider ?? "spawn", "spawnProvider");
  const configToml = config.configToml;
  const states = new WeakMap<DshSession, Promise<SessionState>>();
  const bySessionId = new Map<string, Promise<SessionState>>();
  const liveStates = new Set<Promise<SessionState>>();
  const ownerLease = createDeepSeekHarnessEventOwnerLeases((manifest) =>
    ctx.sessions.registerRequiredEventOwner(manifest));

  const ensureState = (agent: DshAgent): Promise<SessionState> => {
    const existing = states.get(agent.session);
    if (existing !== undefined) return existing;
    const recovering = recoverState(ctx, agent.session, configToml, ownerLease);
    states.set(agent.session, recovering);
    bySessionId.set(agent.session.id, recovering);
    liveStates.add(recovering);
    void recovering.catch(() => {
      if (states.get(agent.session) === recovering) states.delete(agent.session);
      if (bySessionId.get(agent.session.id) === recovering) bySessionId.delete(agent.session.id);
      liveStates.delete(recovering);
    });
    return recovering;
  };

  ctx.on("agent/pre-step", async ({ agent }: { agent: DshAgent }, next: () => Promise<unknown>) => {
    await (await ensureState(agent)).lifecycle.finishPendingSuccess();
    return next();
  }, { prepend: true });

  ctx.on("llm/stream", (request: { sessionId?: string; purpose?: string }, next: () => AsyncIterable<unknown>) => {
    const state = request.purpose === undefined && request.sessionId !== undefined
      ? bySessionId.get(String(request.sessionId))
      : undefined;
    if (state === undefined) return next();
    return beginThenStream(state, request, next);
  }, { prepend: true });

  ctx.on("session/event", (session: DshSession, event: DeepSeekHarnessSessionEvent) => {
    const pending = states.get(session);
    if (pending === undefined) return;
    void pending.then((state) => observeEvent(state.lifecycle, event)).catch(() => undefined);
  });

  ctx.on("agent/request-error", async (
    { agent, signal }: { agent: DshAgent; signal: AbortSignal },
    next: () => Promise<unknown>,
  ) => {
    const state = await ensureState(agent);
    await state.lifecycle.finishNow(signal.aborted ? "cancelled" : "failed");
    return next();
  }, { prepend: true });

  ctx.on("agent/turn-stopping", async ({ agent }: { agent: DshAgent }) => {
    await (await ensureState(agent)).lifecycle.finishPendingSuccess();
  });

  ctx.on("session/disposed", (session: DshSession) => {
    const pending = states.get(session);
    states.delete(session);
    bySessionId.delete(session.id);
    if (pending !== undefined) liveStates.delete(pending);
    if (pending !== undefined) {
      void pending.then(async (state) => {
        await state.lifecycle.drain().catch(() => undefined);
        state.lifecycle.dispose();
        state.runtime.dispose();
      }).catch(() => undefined);
    }
  });

  ctx.effect(() => async () => {
    const settled = await Promise.allSettled([...liveStates]);
    liveStates.clear();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      result.value.lifecycle.dispose();
      result.value.runtime.dispose();
    }
  }, "spine: dispose DSH session runtimes");

  for (const toolName of SPINE_TOOL_NAMES) {
    ctx.tools.register(createTool(ctx, toolName, spawnProvider, ensureState));
  }
}

async function recoverState(
  ctx: DshContext,
  session: DshSession,
  configToml: string | undefined,
  ownerLease: (manifest: DeepSeekHarnessEventManifest) => () => void,
): Promise<SessionState> {
  let runtime: NodeSpineRuntime | undefined;
  let port: DeepSeekHarnessSpinePort<DeepSeekHarnessMessage> | undefined;
  try {
    const plan = buildDeepSeekHarnessReplayPlan(session.id, session.events);
    const recovered = await recoverDeepSeekHarnessSession({
      plan,
      runtimeFactory(thread) {
        runtime = createNodeSpineRuntime({
          thread,
          features: ["jit", "spawn"],
          ...(configToml === undefined ? {} : { configToml }),
        });
        return runtime.client;
      },
      adapterFactory: async (client, bindings) => {
        port = createDeepSeekHarnessSessionPort({
          session,
          sessions: ctx.sessions,
          registerRequiredEventOwner: ownerLease,
          claimOwnership: async () => {
            if (ctx.get("compaction") !== undefined) {
              throw new Error("DSH compaction ownership changed while Spine was enabled");
            }
          },
          materializeContext: (publication) =>
            Promise.resolve(materializeDeepSeekHarnessContext(publication, bindings)),
        });
        const adapter = await createDeepSeekHarnessSpineAdapter({
          enabled: true,
          runtime: client,
          host: port,
        });
        if (adapter === null) throw new Error("Spine adapter unexpectedly disabled");
        return adapter;
      },
    });
    if (runtime === undefined || port === undefined) {
      throw new Error("DSH Spine recovery did not construct its runtime port");
    }
    return {
      lifecycle: new DeepSeekHarnessSamplingLifecycle(
        recovered.adapter,
        recovered.bindings,
        recovered.source,
      ),
      runtime,
      port,
    };
  } catch (error) {
    runtime?.dispose();
    throw error;
  }
}

async function* beginThenStream(
  state: Promise<SessionState>,
  request: unknown,
  next: () => AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  const resolved = await state;
  await resolved.lifecycle.beginSampling(request);
  yield* next();
}

function observeEvent(
  lifecycle: DeepSeekHarnessSamplingLifecycle,
  event: DeepSeekHarnessSessionEvent,
): void {
  if (event.type.startsWith("compaction/")) {
    lifecycle.violate(new Error(`DSH native ${event.type} violates Spine compaction ownership`));
    return;
  }
  if (event.type === "user/message") {
    lifecycle.enqueueMessage(asMessage(event.data));
  } else if (event.type === "assistant/message" && isRecord(event.data)) {
    lifecycle.enqueueMessage(asMessage(event.data.message), inputTokens(event.data.usage));
  } else if (event.type === "tool/result" && isRecord(event.data)) {
    const message = asMessage(event.data.message);
    lifecycle.enqueueToolFinish(toolCallId(message), !toolResultFailed(message));
    lifecycle.enqueueMessage(message);
  } else if (event.type === "tool/call" && isRecord(event.data)) {
    lifecycle.enqueueToolStart({
      callId: requiredString(event.data.callId, "tool/call.callId"),
      name: requiredString(event.data.name, "tool/call.name"),
      arguments: event.data.arguments,
    });
  } else if (event.type === "tool/code-dispatch-start" && isRecord(event.data)) {
    lifecycle.enqueueToolStart({
      callId: requiredString(event.data.subCallId, "tool/code-dispatch-start.subCallId"),
      name: requiredString(event.data.name, "tool/code-dispatch-start.name"),
      arguments: event.data.arguments,
    });
  } else if (event.type === "tool/code-dispatch" && isRecord(event.data)) {
    lifecycle.enqueueToolFinish(
      requiredString(event.data.subCallId, "tool/code-dispatch.subCallId"),
      event.data.isError !== true,
    );
  } else if (event.type === "step/end") {
    lifecycle.enqueueSuccessfulStepEnd();
  } else if (event.type === "turn/end" && isRecord(event.data) && isRecord(event.data.reason)) {
    const kind = event.data.reason.kind;
    if (kind === "aborted") lifecycle.enqueueFinish("cancelled");
    else if (kind === "error" || kind === "blocked") lifecycle.enqueueFinish("failed");
  }
}

function createTool(
  ctx: DshContext,
  toolName: SpineToolName,
  spawnProvider: string,
  ensureState: (agent: DshAgent) => Promise<SessionState>,
): DshToolDefinition {
  const isSpawn = toolName === "spine_spawn";
  return {
    name: toolName,
    description: toolDescription(toolName),
    parameters: isSpawn
      ? {
          type: "object",
          additionalProperties: false,
          required: ["tasks"],
          properties: {
            tasks: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["summary", "prompt"],
                properties: {
                  summary: { type: "string", minLength: 1 },
                  prompt: { type: "string", minLength: 1 },
                },
              },
            },
          },
        }
      : toolParameters(toolName),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error(`${toolName} requires an owning DSH agent`);
      if (!isSpawn) return { status: "accepted" };
      const tasks = decodeSpineSpawnTasks(args);
      const state = await ensureState(agent);
      const results = await executeSpawnBatch({
        batchId: exec.callId,
        tasks,
        signal: exec.signal,
        staging: createDeepSeekHarnessSpawnStagingStore(state.port),
        executor: {
          execute: (task, child) => executeChild(ctx, spawnProvider, agent, task, child.signal),
        },
      });
      await state.lifecycle.stageSpawn(exec.callId, tasks, results);
      return { status: "accepted" };
    },
  };
}

async function executeChild(
  ctx: DshContext,
  provider: string,
  parent: DshAgent,
  task: SpawnTask,
  signal: AbortSignal,
): Promise<SpawnChildTerminal> {
  const run = await ctx.subagents.start(provider, {
    label: task.summary,
    prompt: [{ type: "text", text: task.prompt }],
    parent,
    signal,
    outputSchema: MEMORY_OUTPUT_SCHEMA,
  });
  try {
    const result = await run.result;
    const memory = structuredMemory(result.structured);
    const outcome = result.stopReason === "completed"
      ? "completed"
      : result.stopReason === "aborted" ? "aborted" : "errored";
    return {
      outcome,
      memoryBody: memory,
      executionRef: String(run.id),
      ...(outcome === "completed" ? {} : { diagnostic: `DSH child stopped: ${result.stopReason}` }),
    };
  } finally {
    await run.dispose();
  }
}

function toolParameters(name: Exclude<SpineToolName, "spine_spawn">): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (name === "spine_open" || name === "spine_next") {
    properties.goal = { type: "string", minLength: 1 };
    required.push("goal");
  }
  if (name === "spine_close" || name === "spine_next") {
    properties.memory = { type: "string", minLength: 1 };
    required.push("memory");
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function toolDescription(name: SpineToolName): string {
  switch (name) {
    case "spine_open": return "Open one child Spine scope with a concise summary.";
    case "spine_close": return "Close the active Spine scope with model-authored memory.";
    case "spine_next": return "Close the active Spine scope and open its next sibling.";
    case "spine_spawn": return "Run independent child tasks and return ordered terminal memories.";
  }
}

function asMessage(value: unknown): DeepSeekHarnessMessage {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.content) ||
      !isRecord(value.source) || typeof value.source.kind !== "string" ||
      (value.role !== "system" && value.role !== "user" && value.role !== "assistant")) {
    throw new Error("DSH session event has an invalid typed Message");
  }
  return value as unknown as DeepSeekHarnessMessage;
}

function toolCallId(message: DeepSeekHarnessMessage): string {
  return requiredString(message.source.callId, "tool result source.callId");
}

function toolResultFailed(message: DeepSeekHarnessMessage): boolean {
  const block = message.content.find((item) => item.type === "tool-result");
  return block?.isError === true;
}

function inputTokens(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens];
  if (fields.some((field) => field !== undefined && (!Number.isSafeInteger(field) || Number(field) < 0))) {
    throw new Error("DSH assistant usage contains an invalid input token count");
  }
  if (fields.every((field) => field === undefined)) return undefined;
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" ? field : 0), 0);
}

function structuredMemory(value: unknown): string {
  if (!isRecord(value) || typeof value.memory !== "string" || value.memory.trim().length === 0) {
    throw new Error("DSH Spine child returned no structured model-authored memory");
  }
  return value.memory;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is missing`);
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`Spine ${field} must not be empty`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
