import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildSessionProjection,
  convertToLlm,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CommitBindingRef,
  PluginManifest,
  PostCommitRecord,
  SpinePlugin,
} from "@spinejit/spine-host";
import {
  createNodeSpineRuntime,
  type NodeSpineRuntime,
} from "@spinejit/spine-sdk/node";
import {
  loadSpineConfigToml,
  runSpawnChild,
  SpineToolInputError,
  toArrival,
  type FinishSamplingResult,
  type HostContextEnvelope,
  type PublishedContext,
  type SpawnChildContext,
  type SpawnChildTerminal,
  type SpawnRecoveryPolicy,
} from "@spinejit/spine-sdk/host";
import { Type } from "typebox";

import { watchParent } from "./parent-watch.js";
import type { SpawnArrival, SpawnTask, SpineProjection } from "@spinejit/spine-sdk";
import {
  acceptedChildReturns,
  buildChildAssignment,
  buildChildContinuation,
  childSessionPath,
  CHILD_RETURN_TOOL,
  inspectChildSession,
  readChildReturn,
  readChildSessionIdentity,
  writeChildPrefixSession,
  type ChildBirthRef,
  type ChildSessionScope,
} from "./child-session.js";
import { createPiSpineAdapter } from "./index.js";
import {
  buildCompactBarrier,
  decodeSpawnTasks,
  operationFromPiToolCall,
  PiSamplingLifecycle,
  PiSamplingLifecycleError,
  PiSpineToolMixError,
  PI_SPINE_TOOL_NAMES,
} from "./lifecycle.js";
import {
  arrivalMessage,
  arrivalOf,
  isPiHostSystemMessage,
  materializePiContext,
  projectPiSpineMessages,
  type PiAgentMessage,
  type PiSourceBindings,
} from "./messages.js";
import { resolvePiInvocation } from "./invocation.js";
import {
  linesComponent,
} from "./pretty-tree.js";
import { buildPiReplayPlan, recoverPiSession, type PiBranchEntry, type PiReplaySource } from "./recovery.js";
import { SpineTreeDisplay } from "./tree-view.js";
import { SPINE_TREE_VIEW_REQUEST } from "./tree-view-contract.js";
import { queryPiSpineMode, type PiSpineMode } from "./session-mode.js";
import { PiSpawnChildren, unarrivedBirths, type PiSpawnBirth } from "./spawn-children.js";
import {
  renderSpawnAccepted,
  renderSpawnCall,
  spawnAcceptedDetails,
  spawnAcceptedText,
} from "./spawn-view.js";

const CHILD_FLAG = "spine-child";
const PARENT_PID_FLAG = "spine-parent-pid";
/** Empirical upper bound for Pi's SIGTERM cleanup before the orphan is forced out. */
const ORPHAN_EXIT_GRACE_MS = 6000;
const EXTENSION_MODULE_PATH = fileURLToPath(import.meta.url);

export interface PiExtensionRuntimeFactory {
  create(thread: string): NodeSpineRuntime;
}

export interface PiChildInvocationContext {
  /** The child's birth node id, dotted. */
  readonly producer: string;
  readonly attempt: number;
  readonly mode: "initial" | "continue" | "retry";
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly assignment: string;
  readonly task: SpawnTask;
}

export interface PiChildInvocation {
  readonly command: string;
  readonly args?: readonly string[];
  /** Extension modules are passed in order; the project bridge may replace the canonical default. */
  readonly extensionPaths?: readonly string[];
}

export type PiChildInvocationFactory = (
  context: PiChildInvocationContext,
) => PiChildInvocation | Promise<PiChildInvocation>;

export interface PiSamplingCommitPublication {
  readonly effectType: string;
  readonly binding?: CommitBindingRef;
}

export interface CreatePiExtensionOptions {
  runtimeFactory?: PiExtensionRuntimeFactory;
  childInvocation?: PiChildInvocationFactory;
  onSessionReady?: (info: {
    sessionId: string;
    thread: string;
    epoch: number;
    scopeCursor: readonly number[];
    runtime: NodeSpineRuntime;
    entries: readonly SessionEntry[];
  }) => Promise<void> | void;
  onSamplingCommitPublication?: (info: { sessionId: string; commit: FinishSamplingResult; entries: readonly SessionEntry[] }) => Promise<PiSamplingCommitPublication | void> | PiSamplingCommitPublication | void;
  onSamplingCommit?: (info: { sessionId: string; commit: FinishSamplingResult; entries: readonly SessionEntry[] }) => Promise<void> | void;
}

export const SPINE_CANONICAL_PLUGIN_MANIFEST: PluginManifest = {
  schema: "spine-host/v1",
  id: "@spinejit/pi-spinejit",
  version: "0.1.0",
  owns: ["spine.canonical"],
  toolNamespace: "spine",
  commandNamespace: "spine",
};

export interface CreatePiSpinePluginOptions extends CreatePiExtensionOptions {
  pi: ExtensionAPI;
}

interface ActivePiSession {
  lifecycle: PiSamplingLifecycle;
  runtime: NodeSpineRuntime;
  children: PiSpawnChildren;
  latestContext: PublishedContext;
  materializeMessages(branch: readonly PiBranchEntry[]): PiAgentMessage[];
}

interface MutableSessionSlot {
  mode: PiSpineMode | undefined;
  current: ActivePiSession | null;
  initialization: Promise<ActivePiSession> | null;
  generation: number;
  fault: unknown;
  notified: boolean;
  compactionHandled: boolean;
  compactionAbortCleanup: (() => void) | null;
  treeDisplay: SpineTreeDisplay;
  samplingPrefix: unknown[] | null;
}

/** Creates a real Pi extension factory backed by the packaged Node/WASM SDK. */
export function createPiExtension(options: CreatePiExtensionOptions = {}): ExtensionFactory {
  return (pi) => activatePiExtension(pi, options);
}

export function createPiSpinePlugin(options: CreatePiSpinePluginOptions): SpinePlugin {
  return {
    manifest: SPINE_CANONICAL_PLUGIN_MANIFEST,
    activate(context) {
      activatePiExtension(options.pi, options, context?.effects?.publishCommitted);
    },
  };
}

export default createPiExtension();

function activatePiExtension(
  pi: ExtensionAPI,
  options: CreatePiExtensionOptions,
  publishCommitted?: (record: PostCommitRecord) => Promise<void>,
): void {
  // Ownership is decided at session_start, after every extension factory has
  // registered its synchronous mode responder. Load order cannot select mode.
  const compactionOwnerEvent = "pi:compaction-owner:v1";
  const configToml = loadSpineConfigToml();
  const runtimeFactory = options.runtimeFactory ?? {
    create: (thread: string) => createNodeSpineRuntime({
      thread,
      features: ["jit", "spawn"],
      configToml,
    }),
  };

  pi.registerFlag(CHILD_FLAG, {
    description: "Run as a typed Spine Spawn child",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(PARENT_PID_FLAG, {
    description: "PID of the Spine Spawn parent; the child exits when that process is gone",
    type: "string",
  });
  const slot: MutableSessionSlot = {
    mode: undefined,
    current: null,
    initialization: null,
    generation: 0,
    fault: null,
    notified: false,
    compactionHandled: false,
    compactionAbortCleanup: null,
    treeDisplay: new SpineTreeDisplay(),
    samplingPrefix: null,
  };
  registerSpineTools(pi, configToml);
  const modes = new Map<string, PiSpineMode>();
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const mode = modes.get(sessionId) ?? queryPiSpineMode(pi, ctx);
    modes.set(sessionId, mode);
    const previousMode = slot.mode;
    slot.mode = undefined;
    if (mode === "st") {
      // Inactive alone is insufficient: codemode/deferred tools remain callable.
      registerSpineTools(pi, configToml, "hidden");
      registerChildReturnTool(pi, "hidden");
      slot.generation += 1;
      disposeCurrent(slot);
      slot.initialization = null;
      slot.treeDisplay.reset();
    } else {
      const claim: { owner?: string } = {};
      pi.events.emit(compactionOwnerEvent, claim);
      if (claim.owner !== undefined && claim.owner !== "@spinejit/pi-spinejit") {
        throw new Error(`Pi compaction plugin conflict: @spinejit/pi-spinejit cannot load with ${claim.owner}. Enable only one compaction plugin.`);
      }
      if (previousMode === "st") registerSpineTools(pi, configToml);
    }
    slot.mode = mode;
  });
  pi.events.on(SPINE_TREE_VIEW_REQUEST, (request) => {
    if (slot.mode !== "sdk" || slot.current === null || slot.fault !== null) return;
    slot.treeDisplay.offer(request, slot.generation, slot.current.latestContext.projection);
  });
  registerLifecycleHandlers(
    pi,
    slot,
    runtimeFactory,
    options.onSessionReady,
    options.onSamplingCommitPublication,
    options.onSamplingCommit,
    publishCommitted,
    options.childInvocation,
  );
  pi.events.on(compactionOwnerEvent, (query) => {
    if (slot.mode === "sdk") (query as { owner?: string }).owner ??= "@spinejit/pi-spinejit";
  });
}

function registerSpineTools(
  pi: ExtensionAPI,
  configToml: string,
  exposure: "direct" | "hidden" = "direct",
): void {
  for (const tool of loadCanonicalSpineTools(configToml)) {
    if (tool.name === "spine_spawn") {
      // The tool only acknowledges: the Spawn is staged at tool_call, and the
      // children start after this turn commits their births (turn_end).
      pi.registerTool({
        name: tool.name,
        exposure,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const tasks = decodeSpawnTasks(params as unknown as Record<string, unknown>);
          return {
            content: [{ type: "text", text: spawnAcceptedText(tasks) }],
            details: spawnAcceptedDetails(tasks),
          };
        },
        renderCall(args, theme) {
          const record = isRecord(args) ? args : {};
          const tasks = Array.isArray(record.tasks) ? record.tasks : [];
          return renderSpawnCall(tasks.length, theme);
        },
        renderResult(result, _options, theme) {
          return renderSpawnAccepted(result.details, theme);
        },
      });
      continue;
    }
    pi.registerTool({
      name: tool.name,
      exposure,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      renderShell: "self",
      async execute() {
        return toolResult(`Spine ${tool.name} staged`);
      },
      renderCall() {
        return linesComponent([]);
      },
      renderResult(result, _options, theme, context) {
        if (context.isError) {
          const text = result.content[0];
          const message = text?.type === "text" ? text.text : `${tool.name} failed`;
          return linesComponent([theme.fg("error", message)]);
        }
        return linesComponent([]);
      },
    });
  }
}

function spawnRecoveryPolicy(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): SpawnRecoveryPolicy | undefined {
  if (
    !ctx.hasUI ||
    pi.getFlag(CHILD_FLAG) ||
    typeof ctx.ui.select !== "function"
  ) {
    return undefined;
  }
  return {
    async choose(failure, signal) {
      const choices = [
        ...(failure.continueable ? ["Continue"] : []),
        ...(failure.retryable ? ["Retry"] : []),
        "Abandon",
      ];
      const unavailable = failure.continueable || failure.continueReason === undefined
        ? ""
        : `; Continue unavailable: ${failure.continueReason}`;
      const choice = await ctx.ui.select(
        `Spine Spawn child ${failure.producer.join(".")} (${failure.task.summary}) ${failure.outcome}: ${failure.diagnostic.slice(0, 240)}${unavailable}`,
        choices,
        { signal },
      );
      if (choice === undefined) return undefined;
      if (choice === "Abandon") return { action: "abandon" };
      const guidance = await ctx.ui.input(
        `${choice} guidance (optional)`,
        "Leave empty to continue without guidance",
        { signal },
      );
      if (guidance === undefined) return undefined;
      return {
        action: choice.toLowerCase() as "continue" | "retry",
        ...(guidance.trim().length === 0 ? {} : { guidance: guidance.trim().slice(0, 4096) }),
      };
    },
  };
}

function loadCanonicalSpineTools(configToml: string): Array<{
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Unsafe>;
}> {
  const runtime = createNodeSpineRuntime({
    thread: "pi-tool-catalog",
    features: ["jit", "spawn"],
    configToml,
  });
  try {
    return runtime.toolCatalog().map((tool) => ({
      name: `spine_${tool.id}`,
      label: `Spine ${tool.id[0]?.toUpperCase() ?? ""}${tool.id.slice(1)}`,
      description: tool.description,
      parameters: Type.Unsafe(tool.parameters),
    }));
  } finally {
    runtime.dispose();
  }
}

function childActiveTools(pi: ExtensionAPI): string[] {
  return [
    ...pi.getActiveTools().filter((name) => name !== CHILD_RETURN_TOOL),
    CHILD_RETURN_TOOL,
  ];
}

function childToolAllowlist(pi: ExtensionAPI): string[] {
  return [...new Set([...pi.getActiveTools(), CHILD_RETURN_TOOL].filter((name) => name.trim().length > 0))];
}

function registerChildReturnTool(pi: ExtensionAPI, exposure: "direct" | "hidden" = "direct"): void {
  pi.registerTool({
    name: CHILD_RETURN_TOOL,
    exposure,
    label: "Return Spine Memory",
    description: "Return the complete model-authored terminal memory for this Spawn child.",
    parameters: Type.Object({ memory: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Spine child memory accepted" }],
        details: { accepted: true, memoryBytes: params.memory.length },
        terminate: true,
      };
    },
  });
}

function registerLifecycleHandlers(
  pi: ExtensionAPI,
  slot: MutableSessionSlot,
  runtimeFactory: PiExtensionRuntimeFactory,
  onSessionReady?: CreatePiExtensionOptions["onSessionReady"],
  onSamplingCommitPublication?: CreatePiExtensionOptions["onSamplingCommitPublication"],
  onSamplingCommit?: CreatePiExtensionOptions["onSamplingCommit"],
  publishCommitted?: (record: PostCommitRecord) => Promise<void>,
  childInvocation?: PiChildInvocationFactory,
): void {
  let childMode = false;
  let stopParentWatch: (() => void) | null = null;
  pi.on("session_start", async (_event, ctx) => {
    if (slot.mode !== "sdk") return;
    childMode = pi.getFlag(CHILD_FLAG) === true;
    if (childMode) {
      registerChildReturnTool(pi);
      pi.setActiveTools(childActiveTools(pi));
      // Only a parent that declared its PID can be outlived; a child started by
      // hand (or in-process in tests) has nothing to bind to.
      const parentPid = pi.getFlag(PARENT_PID_FLAG);
      if (typeof parentPid === "string" && parentPid.length > 0) {
        stopParentWatch ??= watchParent({
          expectedParent: Number(parentPid),
          ppid: () => process.ppid,
          onOrphaned: endOrphanedChild,
        });
      }
    }
    await guardHook(pi, slot, ctx, { hook: "session_start", stage: "initialize_session" }, async () => {
      slot.fault = null;
      slot.notified = false;
      slot.compactionHandled = false;
      slot.compactionAbortCleanup?.();
      slot.compactionAbortCleanup = null;
      slot.samplingPrefix = null;
      await beginSessionInitialization(slot, () => initializeSession(pi, slot, ctx, runtimeFactory, onSessionReady));
      if (slot.mode !== "sdk") return;
      const session = await requireSession(slot);
      await recoverChildren(pi, ctx, session, childInvocation);
      renderSpineTree(ctx, slot, session);
    });
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (slot.mode !== "sdk") return;
    await guardHook(pi, slot, ctx, { hook: "session_tree", stage: "initialize_session" }, async () => {
      slot.fault = null;
      slot.notified = false;
      slot.compactionHandled = false;
      slot.compactionAbortCleanup?.();
      slot.compactionAbortCleanup = null;
      slot.samplingPrefix = null;
      await beginSessionInitialization(slot, () => initializeSession(pi, slot, ctx, runtimeFactory, onSessionReady));
      if (slot.mode !== "sdk") return;
      const session = await requireSession(slot);
      await recoverChildren(pi, ctx, session, childInvocation);
      renderSpineTree(ctx, slot, session);
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopParentWatch?.();
    stopParentWatch = null;
    if (slot.mode !== "sdk") return;
    // Direct/RPC reload may run while a context handler is suspended. Cancel
    // while its host ctx is still active; after invalidation ctx.abort throws.
    if (!ctx.isIdle()) ctx.abort();
    slot.fault = abortError("Pi Spine session shut down");
    slot.generation += 1;
    slot.compactionHandled = false;
    slot.compactionAbortCleanup?.();
    slot.compactionAbortCleanup = null;
    slot.samplingPrefix = null;
    disposeCurrent(slot);
    slot.initialization = null;
    slot.treeDisplay.reset();
  });
  pi.on("message_end", async (event, ctx) => {
    if (slot.mode !== "sdk") return;
    await guardHook(pi, slot, ctx, { hook: "message_end", stage: "observe_message" }, async () => {
      const session = await requireSession(slot);
      // A user or custom steering/follow-up message can follow a context-only message that Pi
      // persisted without notifying extension handlers. Admit that durable tail
      // first so live source order agrees with replay. Pi persists this event later.
      if (event.message.role === "user" || event.message.role === "custom") {
        await observePersistedPiSources(session, ctx);
      }
      await session.lifecycle.observeMessage(event.message as PiAgentMessage);
    });
  });
  pi.on("context", async (_event, ctx): Promise<{ messages?: ContextEvent["messages"] }> => {
    if (slot.mode !== "sdk") return {};
    try {
      const session = await requireSession(slot);
      await observePersistedPiSources(session, ctx);
      await session.lifecycle.previewContext();
      assertCurrentSession(slot, session);
      const messages = session.materializeMessages(ctx.sessionManager.getBranch());
      // Pi calls the context hook exactly once per agent-loop model request, and every
      // such request ends in turn_end, so the hook opens the sampling. Provider
      // requests are not samplings: Pi's cache warmer replays the last one through
      // before_provider_request without a turn.
      slot.samplingPrefix = structuredClone(ctx.sessionManager.getBranch());
      await session.lifecycle.beginSampling();
      renderSpineTree(ctx, slot, session);
      return {
        messages: structuredClone(messages) as unknown as ContextEvent["messages"],
      };
    } catch (cause) {
      // Shutdown already cancelled this operation, and its ctx is now stale.
      if (slot.current === null && isAbortError(slot.fault)) return { messages: [] };
      faultAndAbort(pi, slot, ctx, { hook: "context", stage: "preview_context" }, cause);
      return { messages: [] };
    }
  });
  pi.on("context_with_system", async (event) => {
    if (slot.mode !== "sdk") return;
    return { messages: projectPiSpineMessages(event.messages as unknown as PiAgentMessage[]) as unknown as ContextEvent["messages"] };
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (slot.mode !== "sdk" || slot.current === null) return;
    const { children, latestContext } = slot.current;
    if (event.aborted) children.stop();
    const entered = enteredArrivals(ctx);
    children.settle(
      unarrivedBirths(latestContext.projection).filter((birth) => !entered.has(birth.producer.join("."))),
      event.aborted,
    );
    if (event.aborted) return;
    // Without a UI (print mode, Spawn children) Pi exits once the agent settles.
    // Hold it until a running child arrives; that arrival starts the next turn.
    if (!ctx.hasUI) await children.next();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (slot.mode !== "sdk") return;
    const session = await requireSession(slot);
    await observePersistedPiSources(session, ctx);
    if (event.systemPromptOptions === undefined) return;
    event.systemPromptOptions.appendSystemPrompt = session.runtime.extendSystemPrompt(
      event.systemPromptOptions.appendSystemPrompt ?? "",
    );
  });
  pi.on("tool_call", async (event, ctx) => {
    if (slot.mode !== "sdk") return;
    try {
      const admission = childReturnAdmission(slot, event.toolName) ??
        controlToolAdmission(slot, event.toolName, event.input);
      if (admission !== undefined) return admission;
      await (await requireSession(slot)).lifecycle.registerToolCall(
        event.toolCallId,
        event.toolName,
        event.input,
      );
      return undefined;
    } catch (cause) {
      if (cause instanceof PiSpineToolMixError) {
        return { block: true, reason: cause.message };
      }
      if (cause instanceof PiSamplingLifecycleError && cause.cause instanceof SpineToolInputError) {
        return { block: true, reason: cause.cause.message };
      }
      faultAndAbort(pi, slot, ctx, { hook: "tool_call", stage: "register_tool_call" }, cause);
      if ((PI_SPINE_TOOL_NAMES as readonly string[]).includes(event.toolName)) {
        return { block: true, reason: "Spine lifecycle fault", terminate: true };
      }
      return undefined;
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (slot.mode !== "sdk") return;
    await guardHook(pi, slot, ctx, { hook: "tool_result", stage: "finish_tool_call" }, async () => {
      await (await requireSession(slot)).lifecycle.finishToolCall(event.toolCallId, !event.isError);
    });
  });
  pi.on("turn_end", async (event, ctx) => {
    if (slot.mode !== "sdk") return;
    const boundary = { hook: "turn_end", stage: "finish_sampling" };
    await guardHook(pi, slot, ctx, boundary, async () => {
      const commit = await (await requireSession(slot)).lifecycle.finishTurn({
        message: event.message as PiAgentMessage,
        aborted: ctx.signal?.aborted === true,
      });
      if (commit === null || commit.type !== "committed") return;
      boundary.stage = "launch_children";
      launchChildren(pi, ctx, slot, await requireSession(slot), commit.projection, childInvocation);
      const commitInfo = {
        sessionId: ctx.sessionManager.getSessionId(),
        commit,
        entries: ctx.sessionManager.getBranch(),
      };
      boundary.stage = "sampling_commit_publication";
      const publication = await onSamplingCommitPublication?.(commitInfo);
      if (publication !== undefined) {
        if (publishCommitted === undefined) {
          throw new Error("Canonical committed publication requires an active Host owner boundary");
        }
        const rawRecord = commit.record;
        if (rawRecord.type !== "sampling_commit") {
          renderSpineTree(ctx, slot, await requireSession(slot));
          return;
        }
        const sampling = rawRecord.record;
        const operationId = [
          "spine.canonical",
          ctx.sessionManager.getSessionId(),
          sampling.commit_id.thread,
          sampling.epoch,
          sampling.commit_id.value,
        ].join(":");
        boundary.stage = "publish_committed";
        await publishCommitted({
          schema: "spine-tree-post-commit/v1",
          effectType: publication.effectType,
          receipt: {
            schema: "spine-tree-receipt/v1",
            receiptId: `receipt:${operationId}`,
            operationId,
            effectId: commit.transactionId,
            targetOwner: "spine.canonical",
            status: "committed",
            commitId: sampling.commit_id.value,
            ...(publication.binding === undefined ? {} : { binding: publication.binding }),
          },
          record: {
            schema: "spine.canonical.sampling-commit/v1",
            sessionId: ctx.sessionManager.getSessionId(),
            transactionId: commit.transactionId,
            record: sampling,
          },
          projection: commit.projection,
          ...(publication.binding === undefined ? {} : { binding: publication.binding }),
        });
      }
      boundary.stage = "sampling_commit_observer";
      await onSamplingCommit?.(commitInfo);
      boundary.stage = "render_tree";
      renderSpineTree(ctx, slot, await requireSession(slot));
    });
  });
  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      ctx: ExtensionContext,
    ): Promise<{ cancel?: boolean; compaction?: CompactionResult } | undefined> => {
    if (slot.mode !== "sdk") return;
    let session: ActivePiSession;
    try {
      session = await requireSession(slot);
    } catch (cause) {
      faultAndAbort(pi, slot, ctx, { hook: "session_before_compact", stage: "require_session" }, cause);
      return { cancel: true };
    }
    // Compact requires every birth to have arrived; it runs again once they have.
    const pending = unarrivedBirths(session.latestContext.projection);
    if (pending.length > 0) {
      if (ctx.hasUI) ctx.ui.notify(`Spine compaction waits for spawned children ${formatBirths(pending)}`, "warning");
      return { cancel: true };
    }
    let summaryResult: { summary: string; usage?: CompactionResult["usage"] };
    let retained: { messages: PiAgentMessage[]; entryIds: (string | null)[] };
    try {
      summaryResult = await summarizePiCompaction(slot, session, event, ctx);
      if (event.signal?.aborted === true) {
        return { cancel: true };
      }
      assertCurrentSession(slot, session);
      assertCompactionBranch(event, ctx);
      retained = retainedPiMessages(event);
    } catch (cause) {
      if (isPiCompactionHostAbort(event, cause)) return { cancel: true };
      notifyPiCompactionFailure(ctx, cause);
      return { cancel: true };
    }
    try {
      const replacementMessages: PiAgentMessage[] = [
        {
          role: "compactionSummary",
          summary: summaryResult.summary,
          tokensBefore: event.preparation.tokensBefore,
          timestamp: Date.now(),
        },
        ...retained.messages,
      ];
      const source = await session.lifecycle.sourceSnapshot();
      assertCurrentSession(slot, session);
      assertCompactionBranch(event, ctx);
      const barrier = buildCompactBarrier(source, replacementMessages.length);
      await session.lifecycle.compact(barrier, replacementMessages, [null, ...retained.entryIds]);
      slot.compactionHandled = true;
      renderSpineTree(ctx, slot, session);
      const onAbort = () => {
        if (!slot.compactionHandled) return;
        slot.compactionHandled = false;
        slot.compactionAbortCleanup = null;
        faultAndAbort(pi, slot, ctx, { hook: "session_before_compact", stage: "post_compact_abort" }, new Error("Pi compaction aborted after Spine compact completed"));
      };
      event.signal.addEventListener("abort", onAbort, { once: true });
      slot.compactionAbortCleanup = () => event.signal.removeEventListener("abort", onAbort);
      if (event.signal.aborted) {
        onAbort();
        return { cancel: true };
      }
      const compaction: CompactionResult = {
        summary: summaryResult.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      };
      if (summaryResult.usage !== undefined) compaction.usage = summaryResult.usage;
      return {
        compaction,
      };
    } catch (cause) {
      if (!slot.compactionHandled && isPiCompactionHostAbort(event, cause)) {
        return { cancel: true };
      }
      faultAndAbort(pi, slot, ctx, { hook: "session_before_compact", stage: "compact" }, cause);
      return { cancel: true };
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    if (slot.mode !== "sdk") return;
    if (slot.compactionHandled) {
      slot.compactionHandled = false;
      slot.compactionAbortCleanup?.();
      slot.compactionAbortCleanup = null;
      return;
    }
    if (slot.fault !== null) return;
    faultAndAbort(pi, slot, ctx, { hook: "session_compact", stage: "validate_interception" }, new Error("Pi native compaction completed without Spine interception"));
  });
}

async function summarizePiCompaction(
  slot: MutableSessionSlot,
  session: ActivePiSession,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<{ summary: string; usage?: CompactionResult["usage"] }> {
  const model = ctx.model;
  if (model === undefined) throw new Error("Pi compaction requires an active model");
  await observePiBranchSources(session, ctx.sessionManager.getSessionId(), event.branchEntries);
  await session.lifecycle.previewContext();
  assertCurrentSession(slot, session);
  const visible = projectPiSpineMessages(
    session.materializeMessages(event.branchEntries).filter((message) => !isPiHostSystemMessage(message)),
  );
  const tools = currentPiToolDeclarations(event.branchEntries);
  const previous = event.preparation.previousSummary === undefined
    ? ""
    : `\n\nPrevious summary:\n${event.preparation.previousSummary}`;
  const response = await ctx.modelRegistry.complete(
    model,
    {
      ...(tools.length > 0 ? { tools } : {}),
      messages: [
        ...convertToLlm(visible as unknown as Parameters<typeof convertToLlm>[0]),
        {
          role: "user",
          content: [{
            type: "text",
            text: `Create a concise structured continuation summary for this session.${previous}`,
          }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: piNativeSummaryMaxTokens(event.preparation.settings.reserveTokens, model.maxTokens),
      signal: event.signal,
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  );
  if (event.signal?.aborted === true || response.stopReason === "aborted") {
    throw abortError("Pi compaction summarization aborted");
  }
  if (response.stopReason === "error") {
    const detail = typeof response.errorMessage === "string" ? response.errorMessage.trim() : "";
    throw new Error(detail.length > 0 ? detail : "Pi compaction model returned stopReason=error");
  }
  const summary = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (summary.length === 0) throw new Error("Pi compaction model returned an empty summary");
  const usage = response.usage as CompactionResult["usage"];
  return usage === undefined ? { summary } : { summary, usage };
}

type PiToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

function currentPiToolDeclarations(branchEntries: readonly SessionEntry[]): PiToolDeclaration[] {
  const tools = new Map<string, PiToolDeclaration>();
  for (const entry of branchEntries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (!isPiHostSystemMessage(message)) continue;
      const system = message as {
        toolsRemoved?: readonly { name: string }[];
        toolsAdded?: readonly PiToolDeclaration[];
      };
      for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
      for (const added of system.toolsAdded ?? []) tools.set(added.name, added);
    }
  }
  return [...tools.values()];
}

function piNativeSummaryMaxTokens(reserveTokens: number, modelMaxTokens: number): number {
  return Math.min(
    Math.floor(0.8 * reserveTokens),
    modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY,
  );
}

function retainedPiMessages(
  event: { branchEntries: readonly SessionEntry[]; preparation: { firstKeptEntryId: string } },
): { messages: PiAgentMessage[]; entryIds: (string | null)[] } {
  const projection = buildSessionProjection([...event.branchEntries]);
  const start = projection.entries.findIndex(
    (entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId,
  );
  if (start < 0) throw new Error("Pi compaction first-kept entry is missing from the active branch");
  const messages: PiAgentMessage[] = [];
  const entryIds: (string | null)[] = [];
  for (const entry of projection.entries.slice(start)) {
    for (const message of entry.messages) {
      if (isPiHostSystemMessage(message)) continue;
      messages.push(message as PiAgentMessage);
      entryIds.push(entry.sourceEntry.id);
    }
  }
  return { messages, entryIds };
}

function projectedPiMessages(branch: readonly PiBranchEntry[]): Map<string, PiAgentMessage[]> {
  const projected = new Map<string, PiAgentMessage[]>();
  for (const entry of buildSessionProjection(branch as SessionEntry[]).entries) {
    projected.set(
      entry.sourceEntry.id,
      entry.messages.filter((message) => !isPiHostSystemMessage(message)) as PiAgentMessage[],
    );
  }
  return projected;
}

async function observePersistedPiSources(session: ActivePiSession, ctx: ExtensionContext): Promise<void> {
  await observePiBranchSources(session, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
}

async function observePiBranchSources(
  session: ActivePiSession,
  sessionId: string,
  branch: readonly PiBranchEntry[],
): Promise<void> {
  const plan = buildPiReplayPlan({
    currentSessionId: sessionId,
    branch,
    messagesForEntry: (entry) => sessionEntryToContextMessages(entry as SessionEntry) as PiAgentMessage[],
  });
  await session.lifecycle.observePersistedSources(plan.sources);
}

// Host edits can change the rendered view without changing the core plan.
// Bind entry ids and project that view from one synchronous branch snapshot.
function materializeFromBranch(
  publication: PublishedContext,
  bindings: PiSourceBindings,
  branch: readonly PiBranchEntry[],
  nodePrompt: string,
): PiAgentMessage[] {
  assignMissingPiSourceEntryIds(bindings, branch);
  return materializePiContext(publication, bindings, {
    nodePrompt,
    projectedMessages: projectedPiMessages(branch),
  });
}

function assignMissingPiSourceEntryIds(
  bindings: PiSourceBindings,
  branch: readonly PiBranchEntry[],
): void {
  let sources: { entryId: string | null }[];
  try {
    sources = buildPiReplayPlan({
      currentSessionId: "pi-projection",
      branch,
      messagesForEntry: (entry) =>
        sessionEntryToContextMessages(entry as SessionEntry) as PiAgentMessage[],
    }).sources;
  } catch {
    return;
  }
  bindings.assignEntryIds(sources.map((source) => source.entryId));
}

async function initializeSession(
  pi: ExtensionAPI,
  slot: MutableSessionSlot,
  ctx: ExtensionContext,
  runtimeFactory: PiExtensionRuntimeFactory,
  onSessionReady?: CreatePiExtensionOptions["onSessionReady"],
): Promise<ActivePiSession> {
  const plan = buildPiReplayPlan({
    currentSessionId: ctx.sessionManager.getSessionId(),
    branch: ctx.sessionManager.getBranch(),
    messagesForEntry: (entry) =>
      sessionEntryToContextMessages(entry as SessionEntry) as PiAgentMessage[],
  });
  let runtime: NodeSpineRuntime | null = null;
  let runtimeThread: string | null = null;
  let latestContext: HostContextEnvelope<PiAgentMessage> | null = null;

  try {
    const recovered = await recoverPiSession({
      plan,
      runtimeFactory(thread) {
        runtimeThread = thread;
        runtime = runtimeFactory.create(thread);
        return runtime.client;
      },
      async adapterFactory(client, bindings) {
        const adapter = await createPiSpineAdapter({
          enabled: true,
          runtime: client,
          host: {
            async claimOwnership(claim) {
              if (claim.context !== "exclusive-final" || claim.compaction !== "exclusive") {
                throw new Error("Pi Spine received an invalid ownership claim");
              }
            },
            async appendCustomEntry(type, entry) {
              pi.appendEntry(type, entry);
            },
            async materializeContext(context) {
              return materializeFromBranch(context, bindings, ctx.sessionManager.getBranch(), runtime?.nodePrompt() ?? "");
            },
            async replaceContext(context) {
              const installed = structuredClone(context);
              if (latestContext === null) {
                latestContext = installed;
              } else {
                Object.assign(latestContext, installed);
              }
            },
          },
        });
        if (adapter === null) {
          throw new Error("Pi Spine adapter unexpectedly disabled");
        }
        return adapter;
      },
    });
    if (runtime === null || latestContext === null) {
      throw new Error("Pi Spine recovery did not install runtime context");
    }
    const initialContext: PublishedContext = latestContext as HostContextEnvelope<PiAgentMessage>;
    const active: ActivePiSession = {
      lifecycle: new PiSamplingLifecycle(recovered.adapter, recovered.bindings, recovered.source, {
        contextReady: true,
      }),
      runtime,
      children: new PiSpawnChildren((arrival, wake) => deliverArrival(pi, slot, active, arrival, wake)),
      latestContext: initialContext,
      materializeMessages(branch: readonly PiBranchEntry[]) {
        return materializeFromBranch(initialContext, recovered.bindings, branch, runtime!.nodePrompt());
      },
    };
    if (onSessionReady && runtimeThread !== null) {
      await onSessionReady({
        sessionId: ctx.sessionManager.getSessionId(),
        thread: runtimeThread,
        epoch: recovered.source.epoch,
        scopeCursor: [...initialContext.projection.cursor],
        runtime,
        entries: ctx.sessionManager.getBranch(),
      });
    }
    return active;
  } catch (cause) {
    (runtime as NodeSpineRuntime | null)?.dispose();
    throw cause;
  }
}

function childRuntimeFlags(ctx: ExtensionContext): string[] {
  const flags: string[] = [];
  const model = ctx.model;
  if (model !== undefined) {
    flags.push("--provider", model.provider, "--model", model.id);
  }
  if (ctx.thinkingLevel !== undefined) {
    flags.push("--thinking", ctx.thinkingLevel);
  }
  if (process.argv.includes("--approve")) {
    flags.push("--approve");
  }
  return flags;
}

/** One attempt of one child: a fresh session from the birth prefix, or the same session continued. */
async function executePiChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  scope: ChildSessionScope,
  birth: ChildBirthRef,
  prefix: readonly unknown[] | null,
  peers: readonly SpawnTask[],
  task: SpawnTask,
  child: SpawnChildContext,
  sessionIds: Map<number, string>,
  childInvocation?: PiChildInvocationFactory,
): Promise<SpawnChildTerminal> {
  const producer = child.producer.join(".");
  const destPath = childSessionPath(scope, birth, child.attempt);
  let sessionId: string;
  let prompt: string;
  const assignment = buildChildAssignment(task, peers);
  if (child.mode === "initial" || child.mode === "retry") {
    if (prefix === null) throw new Error(`Pi Spawn child ${producer} has no birth context to start from`);
    sessionId = await writeChildPrefixSession({
      cwd: ctx.cwd,
      destPath,
      entries: prefix,
      ...(scope.parentSessionFile === undefined ? {} : { parentSession: scope.parentSessionFile }),
    });
    sessionIds.set(child.attempt, sessionId);
    prompt = assignment;
  } else {
    try {
      const inspection = await inspectChildSession({
        cwd: ctx.cwd,
        destPath,
        expectedId: sessionIds.get(child.attempt) ?? await readChildSessionIdentity(destPath),
        assignment,
      });
      sessionId = inspection.id;
      prompt = inspection.assignmentPresent
        ? buildChildContinuation(child.guidance)
        : buildChildContinuation(child.guidance, assignment);
    } catch (cause) {
      const diagnostic = clipSpawnDiagnostic(cause instanceof Error ? cause.message : String(cause));
      return {
        outcome: "errored",
        diagnostic,
        executionRef: `${producer}:attempt-${child.attempt}:missing-session`,
        recovery: { continueable: false, reason: diagnostic },
      };
    }
  }
  const invocation = childInvocation === undefined
    ? { ...piInvocation(), extensionPaths: [EXTENSION_MODULE_PATH] }
    : await childInvocation({
      producer,
      attempt: child.attempt,
      mode: child.mode,
      sessionId,
      sessionPath: destPath,
      assignment,
      task,
    });
  if (typeof invocation.command !== "string" || invocation.command.length === 0) {
    throw new Error("Pi Spawn child invocation requires a command");
  }
  const extensionPaths = invocation.extensionPaths ?? [EXTENSION_MODULE_PATH];
  if (extensionPaths.length === 0 || extensionPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("Pi Spawn child invocation requires at least one extension module");
  }
  const tools = childToolAllowlist(pi);
  const result = await pi.exec(
    invocation.command,
    [
      ...(invocation.args ?? []),
      "--mode",
      "json",
      "-p",
      "--session",
      destPath,
      ...extensionPaths.flatMap((path) => ["--extension", path]),
      `--${CHILD_FLAG}=true`,
      `--${PARENT_PID_FLAG}=${process.pid}`,
      ...(tools.length === 0 ? [] : ["--tools", tools.join(",")]),
      ...childRuntimeFlags(ctx),
      prompt,
    ],
    { cwd: ctx.cwd, signal: child.signal },
  );
  const executionRef = `${producer}:attempt-${child.attempt}:${sessionId}`;
  const processDiagnostic = childProcessDiagnostic(result);
  // The child's own session is its result record, the same one recovery reads.
  const accepted = acceptedChildReturns(await readFile(destPath, "utf8"));
  if (accepted.length !== 1) {
    return {
      outcome: result.killed ? "aborted" : "errored",
      diagnostic: clipSpawnDiagnostic(`Pi Spawn child accepted ${accepted.length} typed returns; ${processDiagnostic}`),
      executionRef,
    };
  }
  // The typed return is the child's result; a later exit status does not undo it.
  return {
    outcome: "completed",
    memory: accepted[0]!,
    ...(result.code === 0 ? {} : { diagnostic: clipSpawnDiagnostic(processDiagnostic) }),
    executionRef,
  };
}

function childProcessDiagnostic(result: { stderr: string; code: number }): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : `Pi child exited with code ${result.code}`;
}

function clipSpawnDiagnostic(text: string): string {
  return text.length <= 1200 ? text : text.slice(0, 1200);
}

const CONTROL_TOOLS = ["spine_open", "spine_close", "spine_next"] as const;

function controlToolAdmission(
  slot: MutableSessionSlot,
  toolName: string,
  input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
  if (!CONTROL_TOOLS.includes(toolName as (typeof CONTROL_TOOLS)[number])) return undefined;
  operationFromPiToolCall(toolName as (typeof CONTROL_TOOLS)[number], input);
  const fault = slot.fault ?? slot.current?.lifecycle.fault ?? null;
  if (fault !== null) {
    const detail = fault instanceof Error ? fault.message : String(fault);
    return { block: true, reason: `Spine durability is faulted: ${detail}` };
  }
  if (toolName === "spine_open" || slot.current === null) return undefined;
  const projection = slot.current.latestContext.projection;
  const cursor = projection.nodes.find((node) =>
    node.id.length === projection.cursor.length &&
    node.id.every((part, index) => part === projection.cursor[index]),
  );
  if (cursor === undefined) {
    return { block: true, reason: "Spine cursor is missing from the derived tree" };
  }
  if ((toolName === "spine_close" || toolName === "spine_next") && cursor.kind === "RootEpoch") {
    return { block: true, reason: "no open Spine node is available to close" };
  }
  const pending = unarrivedBirths(projection, projection.cursor);
  if (pending.length > 0) {
    return {
      block: true,
      reason: `Spawned children ${formatBirths(pending)} have not arrived. Each result arrives as its own message; close this node after they have arrived.`,
    };
  }
  return undefined;
}

/** A child returns its memory only after its own spawned children have arrived. */
function childReturnAdmission(
  slot: MutableSessionSlot,
  toolName: string,
): { block: true; reason: string } | undefined {
  if (toolName !== CHILD_RETURN_TOOL || slot.current === null) return undefined;
  const pending = unarrivedBirths(slot.current.latestContext.projection);
  if (pending.length === 0) return undefined;
  return {
    block: true,
    reason: `Spawned children ${formatBirths(pending)} have not arrived. Each result arrives as its own message; return after they have arrived.`,
  };
}

function formatBirths(births: readonly PiSpawnBirth[]): string {
  return births.map((birth) => `${birth.producer.join(".")} (${birth.task.summary})`).join(", ");
}

function childScope(ctx: ExtensionContext): ChildSessionScope {
  const parentSessionFile = ctx.sessionManager.getSessionFile();
  return {
    parentSessionId: ctx.sessionManager.getSessionId(),
    ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
  };
}

/** Names each birth by the Pi entry at its sampling's first source boundary on the current branch. */
/** The session's branch as the Spine sources it holds, each with its Pi entry. */
function branchSources(ctx: ExtensionContext): PiReplaySource[] {
  return buildPiReplayPlan({
    currentSessionId: ctx.sessionManager.getSessionId(),
    branch: ctx.sessionManager.getBranch(),
    messagesForEntry: (entry) =>
      sessionEntryToContextMessages(entry as SessionEntry) as PiAgentMessage[],
  }).sources;
}

/** Producers whose arrival is in the session's source, admitted or not yet committed. */
function enteredArrivals(ctx: ExtensionContext): Set<string> {
  return new Set(branchSources(ctx).flatMap((source) => {
    const arrival = arrivalOf(source.message);
    return arrival === null ? [] : [arrival.producer.join(".")];
  }));
}

function birthRefs(ctx: ExtensionContext, births: readonly PiSpawnBirth[]): ChildBirthRef[] {
  const entries = new Map(branchSources(ctx).map((source) => [source.boundary, source.entryId]));
  return births.map((birth) => {
    const origin = entries.get(birth.start);
    if (origin === undefined || origin === null) {
      throw new Error(`Pi Spawn birth ${birth.producer.join(".")} has no session entry at boundary ${birth.start}`);
    }
    return { origin, producer: birth.producer };
  });
}

/** Starts the children whose births this commit made; the sampling prefix is their fixed birth context. */
function launchChildren(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  slot: MutableSessionSlot,
  session: ActivePiSession,
  projection: SpineProjection,
  childInvocation?: PiChildInvocationFactory,
): void {
  const births = unarrivedBirths(projection);
  if (births.length === 0) return;
  const prefix = slot.samplingPrefix;
  const scope = childScope(ctx);
  const refs = new Map(birthRefs(ctx, births).map((ref) => [ref.producer.join("."), ref]));
  const recovery = spawnRecoveryPolicy(ctx, pi);
  session.children.launch(births, (birth, peers, signal) => {
    const ref = refs.get(birth.producer.join("."))!;
    const sessionIds = new Map<number, string>();
    return runSpawnChild({
      producer: birth.producer,
      task: birth.task,
      signal,
      ...(recovery === undefined ? {} : { recovery }),
      executor: {
        execute: (task, child) =>
          executePiChild(pi, ctx, scope, ref, prefix, peers, task, child, sessionIds, childInvocation),
      },
    });
  });
}

/**
 * After a restart no child of this session is running. A child that already
 * returned is delivered from its own session record without running again; one
 * that did not return awaits a recovery decision, and without a UI is abandoned.
 */
async function recoverChildren(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: ActivePiSession,
  childInvocation?: PiChildInvocationFactory,
): Promise<void> {
  const births = unarrivedBirths(session.latestContext.projection);
  if (births.length === 0) return;
  const scope = childScope(ctx);
  const refs = birthRefs(ctx, births);
  const recovery = spawnRecoveryPolicy(ctx, pi);
  for (const [index, birth] of births.entries()) {
    const ref = refs[index]!;
    const returned = await readChildReturn(scope, ref);
    if (returned.memory !== null) {
      session.children.redeliver(toArrival(birth.producer, { outcome: "completed", memory: returned.memory }));
      continue;
    }
    const latest = returned.latest;
    const sessionIds = new Map<number, string>();
    session.children.start(birth, (signal) => runSpawnChild({
      producer: birth.producer,
      task: birth.task,
      signal,
      ...(recovery === undefined ? {} : { recovery }),
      executor: {
        async execute(task, child) {
          if (child.mode === "initial") {
            return {
              outcome: "aborted",
              diagnostic: "the parent session restarted before this child returned",
              recovery: latest === null
                ? { continueable: false, retryable: false, reason: "no child session was saved" }
                : { continueable: true, retryable: false },
            };
          }
          return executePiChild(pi, ctx, scope, ref, null, [], task, {
            ...child,
            attempt: (latest?.attempt ?? 0) + child.attempt,
          }, sessionIds, childInvocation);
        },
      },
    }), false);
  }
}

/** Admits each producer at most once: an arrival goes only to the session that bore it, while unarrived. */
function deliverArrival(
  pi: ExtensionAPI,
  slot: MutableSessionSlot,
  session: ActivePiSession,
  arrival: SpawnArrival,
  wake: boolean,
): void {
  if (slot.current !== session) return;
  const key = arrival.producer.join(".");
  if (!unarrivedBirths(session.latestContext.projection).some((birth) => birth.producer.join(".") === key)) return;
  pi.sendMessage(arrivalMessage(arrival), { deliverAs: "steer", triggerTurn: wake });
}

function assertCurrentSession(slot: MutableSessionSlot, session: ActivePiSession): void {
  if (slot.current !== session) throw new Error("Pi Spine session changed while preparing context");
  const fault = slot.fault ?? session.lifecycle.fault;
  if (fault !== null) throw new Error("Pi Spine extension is faulted", { cause: fault });
}

function assertCompactionBranch(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
  // A manual summary can await the provider while an idle custom message is
  // persisted. Cancel before the compact barrier rather than swallowing its tail.
  const branch = ctx.sessionManager.getBranch();
  if (branch.at(-1)?.id !== event.branchEntries.at(-1)?.id) {
    throw abortError("Pi session changed during compaction; no compact was committed");
  }
}

async function requireSession(slot: MutableSessionSlot): Promise<ActivePiSession> {
  if (slot.fault !== null) throw new Error("Pi Spine extension is faulted", { cause: slot.fault });
  if (slot.current !== null) return slot.current;
  if (slot.initialization !== null) return slot.initialization;
  throw new Error("Pi Spine session is not initialized");
}

async function beginSessionInitialization(
  slot: MutableSessionSlot,
  initialize: () => Promise<ActivePiSession>,
): Promise<void> {
  const generation = slot.generation + 1;
  slot.generation = generation;
  slot.treeDisplay.reset();
  disposeCurrent(slot);
  const pending = initialize();
  slot.initialization = pending;
  try {
    const session = await pending;
    if (slot.generation !== generation) {
      session.runtime.dispose();
      return;
    }
    slot.current = session;
    slot.initialization = null;
  } catch (cause) {
    if (slot.generation !== generation) return;
    slot.initialization = null;
    throw cause;
  }
}

interface PiHookBoundary {
  hook: string;
  stage: string;
}

async function guardHook(
  pi: ExtensionAPI,
  slot: MutableSessionSlot,
  ctx: ExtensionContext,
  boundary: PiHookBoundary,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    faultAndAbort(pi, slot, ctx, boundary, cause);
  }
}

/** Diagnostic only: never archive payloads, model context, or arbitrary error properties. */
function faultErrors(cause: unknown): { name: string; code?: string; message: string }[] {
  const errors: { name: string; code?: string; message: string }[] = [];
  for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code.slice(0, 128) : undefined;
    errors.push({
      name: cause instanceof Error ? cause.name.slice(0, 128) : "NonErrorThrow",
      ...(code === undefined ? {} : { code }),
      message: (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Non-Error thrown value").slice(0, 2048),
    });
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return errors;
}

function faultAndAbort(
  pi: ExtensionAPI,
  slot: MutableSessionSlot,
  ctx: ExtensionContext,
  boundary: PiHookBoundary,
  cause: unknown,
): void {
  const firstFault = slot.fault === null;
  slot.fault ??= cause;
  if (firstFault) {
    const diagnostic = {
      schema: "spine.fault/v1",
      ...boundary,
      timestamp: Date.now(),
      errors: faultErrors(cause),
    };
    try {
      const projection = slot.current?.latestContext.projection;
      pi.appendEntry("spine.fault.v1", {
        ...diagnostic,
        sessionId: ctx.sessionManager.getSessionId(),
        transactionId: slot.current?.latestContext.transactionId ?? null,
        ...(projection === undefined ? {} : {
          cursor: [...projection.cursor],
          lastBoundary: projection.last_boundary,
        }),
      });
    } catch (persistenceError) {
      // Keep the original latch and cancellation even when the session store fails.
      console.error(JSON.stringify({ ...diagnostic, persistenceErrors: faultErrors(persistenceError) }));
    }
  }
  ctx.abort();
  if (!slot.notified && ctx.hasUI) {
    slot.notified = true;
    ctx.ui.notify("Spine faulted; current Pi operation aborted", "error");
  }
}

function isPiCompactionHostAbort(event: SessionBeforeCompactEvent, cause: unknown): boolean {
  return event.signal?.aborted === true || isAbortError(cause);
}

function notifyPiCompactionFailure(ctx: ExtensionContext, cause: unknown): void {
  const message = cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "Pi compaction failed";
  ctx.ui.notify(message, "error");
}

/**
 * The parent that would read this child's terminal memory is gone. Take Pi's own
 * SIGTERM path (stop tracked tool processes, emit session_shutdown, which aborts
 * a running turn, then exit); it also covers a child that has not started its
 * turn yet. The session file stays for recovery.
 */
function endOrphanedChild(): void {
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(1), ORPHAN_EXIT_GRACE_MS).unref();
}

function isAbortError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError";
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function disposeCurrent(slot: MutableSessionSlot): void {
  slot.current?.children.dispose();
  slot.current?.runtime.dispose();
  slot.current = null;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { staged: true } };
}

function piInvocation(): { command: string; args: string[] } {
  return resolvePiInvocation({
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
  });
}

function renderSpineTree(ctx: ExtensionContext, slot: MutableSessionSlot, session: ActivePiSession): void {
  slot.treeDisplay.publish(ctx, slot.generation, session.latestContext.projection);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
