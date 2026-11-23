import { addAbortListener } from "node:events";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { isAgentLoopRequest, type UserMessage } from "@deepseek-ai/dsh-llm";
import { pluginRecordOf, type SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { isSpineToolName, loadSpineConfigToml, SpawnChildren, toArrival } from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime, type SpineToolSpec } from "@spinejit/spine-sdk/node";

import { SPINE_FEATURES, SpineAgent } from "./agent.js";
import { userAnchorsProjection } from "./anchors.js";
import { TreeDisplay, treeProjection } from "./display.js";
import { arrivalMessage, SpineDshError } from "./events.js";
import { withoutReasoningProjection } from "./reasoning.js";
import { executeChild, recoverChildren, sessionBirth, spineSubagentProvider, type SpineWorld } from "./spawn.js";
import { registerTreeView } from "./tui.js";
import { TREE_RECORD } from "./tree.js";

type ReloadRecovery = { signal: AbortSignal; wake: boolean };

/** The Cordis plugin DeepSeek Harness loads, by package name, from a bundle. */
export const name = "spinejit";
export const inject = ["agents", "llm", "sessionPersistence", "sessions", "subagents", "systemPrompt", "tools"];

export function apply(ctx: Context): void {
  const configToml = loadSpineConfigToml();
  const catalog = createNodeSpineRuntime({ thread: "dsh-tool-catalog", features: SPINE_FEATURES, configToml });
  let tools: SpineToolSpec[];
  let prompt: string;
  try {
    tools = catalog.toolCatalog();
    prompt = catalog.extendSystemPrompt("").trim();
  } finally {
    catalog.dispose();
  }

  const liveAgents = ctx.agents.list();
  const previousAgents = new WeakSet(liveAgents);
  const lifetime = new AbortController();
  const agents = new Map<string, SpineAgent>();
  const children = new Map<string, SpawnChildren>();
  const attaching = new Map<Agent, Promise<SpineAgent>>();
  const disposers = new Map<Agent, () => void | Promise<void>>();
  const recoveredClaims = new Map<Agent, Set<string>>();
  const pendingStopClaims = new Map<Agent, Set<string>>();
  const stepCancellations = new Map<Agent, UserMessage[]>();
  const waitingParents = new Map<Agent, AbortController>();
  let unloading = false;
  const world: SpineWorld = { ctx, agents, children, idle: new Map(), starting: new Map() };
  ctx.sessions.registerMessageProjection(withoutReasoningProjection);
  ctx.sessions.registerMessageProjection(userAnchorsProjection);
  ctx.subagents.registerProvider(spineSubagentProvider(world.starting));
  ctx.systemPrompt.section({ name: "spinejit", order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK"), text: prompt });
  for (const tool of tools) ctx.tools.register(spineTool(tool, agents));

  // The tree each agent shows: a session projection for clients when the host
  // has the registry, and status rows when dsh-tui is composed.
  const display = new TreeDisplay();
  ctx.inject(["sessionProjections"] as never, ((projectionCtx: Context) => {
    (projectionCtx as unknown as { sessionProjections: { register(definition: unknown): unknown } })
      .sessionProjections.register(treeProjection);
  }) as never);
  registerTreeView(ctx, display);

  function rememberClaim(agent: Agent, producer: string): void {
    let recovered = recoveredClaims.get(agent);
    if (recovered === undefined) recoveredClaims.set(agent, recovered = new Set());
    recovered.add(producer);
  }

  ctx.on("session/event", (session, event) => {
    agents.get(session.id)?.accept(event);
    if (event.type === "agent/inbox/spliced" && event.data.inserted.length > 0) world.idle.get(session.id)?.input();
  });
  // On reload, read the old child's persisted result only after its writer
  // drains. DSH unregisters the agent after closing that writer.
  async function waitForPreviousChild(id: SessionId): Promise<void> {
    const child = ctx.agents.get(id);
    lifetime.signal.throwIfAborted();
    if (child === undefined || !previousAgents.has(child)) return;
    await new Promise<void>((resolve, reject) => {
      const stop = ctx.on("agent/disposed", ({ agent }) => {
        if (agent !== child) return;
        cleanup();
        resolve();
      });
      const abort = () => {
        cleanup();
        reject(lifetime.signal.reason);
      };
      const cleanup = () => {
        stop();
        lifetime.signal.removeEventListener("abort", abort);
      };
      lifetime.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function restoreAgent(
    agent: Agent,
    claimed: readonly UserMessage[],
    reload?: ReloadRecovery,
    recoveredInStep?: UserMessage[],
  ): Promise<SpineAgent> {
    // A pre-step may already have claimed an arrival, removing it from the
    // inbox before the step writes that message to the session.
    const claimedArrivals = new Set(claimed.flatMap(({ source }) =>
      source.kind === "spine-arrival" ? [source.arrival.producer.join(".")] : []));
    const keyOf = (producer: readonly number[]) => producer.join(".");
    const awaitingArrival = (producer: string) =>
      ctx.agents.get(agent.id) === agent && !lifetime.signal.aborted
      && agents.get(agent.id)?.openBirths().some((birth) => keyOf(birth.producer) === producer) === true
      && ![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(({ source }) =>
        source.kind === "spine-arrival" && keyOf(source.arrival.producer) === producer);
    let wakingArrival: string | undefined;
    let stoppedBatch: UserMessage[] | undefined;
    // An arrival enters only the session that bore it, once, while its birth is
    // open. The inbox is durable, so one pending there has already been sent.
    const own = new SpawnChildren((arrival, wake) => {
      const producer = keyOf(arrival.producer);
      const alreadyClaimed = claimedArrivals.has(producer);
      if (!alreadyClaimed && !awaitingArrival(producer)) return;
      if (alreadyClaimed || recoveredInStep !== undefined) {
        rememberClaim(agent, producer);
        if (!alreadyClaimed) {
          recoveredInStep?.push(arrivalMessage(arrival));
          claimedArrivals.add(producer);
        }
        return;
      }
      const message = arrivalMessage(arrival);
      if (stoppedBatch !== undefined) {
        stoppedBatch.push(message);
        let claims = pendingStopClaims.get(agent);
        if (claims === undefined) pendingStopClaims.set(agent, claims = new Set());
        claims.add(producer);
      } else if (wake || (producer === wakingArrival && !reload?.signal.aborted)) agent.steer(message);
      else agent.inject(message);
    });
    display.open(agent.session);
    const replayFrom = agent.session.seq;
    let state: SpineAgent | undefined;
    try {
      const spine = state = await SpineAgent.create(agent, configToml, async (births, prefixEnd, stopped) => {
        if (stopped) {
          stoppedBatch = stepCancellations.get(agent);
          try {
            for (const birth of births) own.redeliver(toArrival(birth.producer, { outcome: "aborted" }, true));
          } finally {
            stoppedBatch = undefined;
          }
          return;
        }
        const started: Promise<void>[] = [];
        own.launch(births, (birth, peers, signal) => {
          let start!: () => void;
          started.push(new Promise((resolve) => { start = resolve; }));
          return executeChild(world, agent, birth, peers, prefixEnd, signal, (arrival) => own.arrive(arrival), start);
        });
        await Promise.all(started);
      }, (projection) => display.update(agent.session, projection));
      lifetime.signal.throwIfAborted();
      // Events committed while the asynchronous replay was in progress did
      // not reach a live SpineAgent yet.
      if (agent.session.seq !== replayFrom) {
        for (const event of agent.session.snapshotEvents()) {
          if (event.seq >= replayFrom) spine.accept(event);
        }
      }
      agents.set(agent.id, spine);
      children.set(agent.id, own);
      if (spine.projection !== null) display.update(agent.session, spine.projection);
      try {
        const arrivals = await recoverChildren(world, agent, spine.openBirths(), waitForPreviousChild);
        lifetime.signal.throwIfAborted();
        // Batch the recovered results before waking the parent with the last
        // one. Already queued results need no second delivery.
        if (reload?.wake && !reload.signal.aborted) {
          for (const { producer } of arrivals) {
            const key = keyOf(producer);
            if (!claimedArrivals.has(key) && awaitingArrival(key)) wakingArrival = key;
          }
        }
        for (const arrival of arrivals) own.redeliver(arrival);
      } finally {
        wakingArrival = undefined;
        claimedArrivals.clear();
        recoveredInStep = undefined;
      }
      const dispose = agent.ctx.effect(() => async () => {
        // The turn in flight can use its state until it stops. A resumed
        // session recovers a stopped child's result from the log.
        own.dispose();
        await agent.whenIdle();
        forgetAgent(agent, spine);
      });
      disposers.set(agent, dispose);
      return spine;
    } catch (error) {
      own.dispose();
      forgetAgent(agent, state);
      throw error;
    }
  }

  function forgetAgent(agent: Agent, spine: SpineAgent | undefined): void {
    agents.delete(agent.id);
    children.delete(agent.id);
    disposers.delete(agent);
    recoveredClaims.delete(agent);
    pendingStopClaims.delete(agent);
    display.close(agent.id);
    spine?.dispose();
  }

  async function attachAgent(
    agent: Agent,
    claimed: readonly UserMessage[] = [],
    reload?: ReloadRecovery,
    recoveredInStep?: UserMessage[],
  ): Promise<SpineAgent> {
    if (unloading) throw new SpineDshError("Spine is reloading; retry this turn once it is ready");
    const pending = attaching.get(agent);
    if (pending !== undefined) return pending;
    const existing = agents.get(agent.id);
    if (existing !== undefined) return existing;
    const attached = restoreAgent(agent, claimed, reload, recoveredInStep);
    attaching.set(agent, attached);
    try {
      const spine = await attached;
      if (unloading) throw new SpineDshError("Spine is reloading; retry this turn once it is ready");
      return spine;
    } finally {
      attaching.delete(agent);
    }
  }

  function canRecoverWaitingParent(agent: Agent): boolean {
    if (unloading || !previousAgents.has(agent) || ctx.agents.get(agent.id) !== agent
      || agent.status !== "idle" || sessionBirth(agent.id) !== null || agents.has(agent.id) || attaching.has(agent)) return false;
    // A token-limited reply can leave the parent waiting just like a normal
    // reply. The latest tree must still contain births that this agent owns.
    const end = lastTurnEnd(agent);
    return (end === "completed" || end === "max-tokens") && waitingForChildren(agent);
  }

  // A live parent may finish its waiting reply after the reload has mounted.
  // Use the same recovery for those parents and ones already idle at mount.
  function recoverWaitingParent(agent: Agent): void {
    if (waitingParents.has(agent) || !canRecoverWaitingParent(agent)) return;
    const wait = new AbortController();
    waitingParents.set(agent, wait);
    void (async () => {
      let wake = true;
      do {
        let recovery: Promise<void>;
        try {
          recovery = agent.runMaintenance(async (signal) => {
            await attachAgent(agent, [], { signal, wake });
          });
        } catch {
          // Host maintenance reports idle throughout and only its owner sees
          // cancellation. Recover the results, but don't override a possible Stop.
          wake = false;
          let stop!: () => void;
          const stopped = new Promise<void>((resolve) => { stop = resolve; });
          const listener = addAbortListener(wait.signal, stop);
          try {
            await Promise.race([agent.whenIdle(), stopped]);
          } finally {
            listener[Symbol.dispose]();
          }
          continue;
        }
        await recovery;
        return;
      } while (!wait.signal.aborted && canRecoverWaitingParent(agent));
    })().catch((error: unknown) => {
      if (!unloading && !wait.signal.aborted) ctx.logger.error(error);
    }).finally(() => {
      waitingParents.delete(agent);
    });
  }

  ctx.on("agent/created", async ({ agent }) => { await attachAgent(agent); });
  ctx.on("agent/disposed", ({ agent }) => { waitingParents.get(agent)?.abort(); });
  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle") return;
    const spine = agents.get(agent.id);
    const own = children.get(agent.id);
    if (spine === undefined || own === undefined) {
      recoverWaitingParent(agent);
      return;
    }
    // A stopped agent stops its children; their arrivals do not wake it.
    const aborted = lastTurnEnd(agent) === "aborted";
    if (aborted) own.stop();
    const open = spine.openBirths();
    const claimed = recoveredClaims.get(agent);
    const stopClaims = pendingStopClaims.get(agent);
    if (claimed !== undefined || stopClaims !== undefined) {
      // Keep claims until DSH logs them, even if several steps are rejected.
      const openProducers = new Set(open.map(({ producer }) => producer.join(".")));
      for (const producer of claimed ?? []) if (!openProducers.has(producer)) claimed?.delete(producer);
      for (const producer of stopClaims ?? []) if (!openProducers.has(producer)) stopClaims?.delete(producer);
      if (claimed?.size === 0) recoveredClaims.delete(agent);
      if (stopClaims?.size === 0) pendingStopClaims.delete(agent);
    }
    own.settle(open, aborted || (claimed?.size ?? 0) > 0 || (stopClaims?.size ?? 0) > 0);
    world.idle.get(agent.id)?.settle(aborted);
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    // Existing agents do not emit agent/created again after a plugin reload.
    const { agent } = payload;
    // DSH has already claimed input, so include arrivals from reattachment in
    // this decision instead of queueing them for a second model request.
    const recovered: UserMessage[] | undefined = payload.messages.some(({ source }) => source.kind === "user") ? [] : undefined;
    const spine = await attachAgent(agent, payload.messages, undefined, recovered);
    // DSH removes these arrivals from the inbox before deciding whether the
    // step is admitted. Protect claims on every step, including arrivals parked
    // by earlier background recovery on an already attached agent. Idle settles
    // redeliver them without waking until their sources actually reach the log.
    for (const { source } of payload.messages) {
      if (source.kind === "spine-arrival") rememberClaim(agent, source.arrival.producer.join("."));
    }
    const cancellations: UserMessage[] = [];
    stepCancellations.set(agent, cancellations);
    try {
      await spine.settle();
    } finally {
      stepCancellations.delete(agent);
    }
    const decision = await next();
    if (decision.kind !== "enter" || decision.messages.length === 0) return decision;
    const recoveredForInput = decision.messages.some(({ source }) => source.kind === "user") ? recovered ?? [] : [];
    const included = new Set(decision.messages.flatMap(({ source }) =>
      source.kind === "spine-arrival" ? [source.arrival.producer.join(".")] : []));
    const arrivals = [...recoveredForInput, ...cancellations].filter(({ source }) => {
      if (source.kind !== "spine-arrival") return false;
      const producer = source.arrival.producer.join(".");
      if (included.has(producer)) return false;
      included.add(producer);
      return true;
    });
    return arrivals.length === 0 ? decision : { ...decision, messages: [...arrivals, ...decision.messages] };
  }, { prepend: true });
  ctx.on("agent/request", async (payload, next) => {
    const spine = await attachAgent(payload.agent);
    await spine.enterStep(payload.turn, payload.step);
    return next();
  }, { prepend: true });
  ctx.on("llm/stream", (request, next) => {
    if (!isAgentLoopRequest(request) || request.sessionId === undefined) return next();
    const sessionId = request.sessionId;
    return (async function* () {
      const spine = agents.get(sessionId);
      if (spine === undefined || unloading) {
        // Reloaded after the request hook. The model input is already frozen;
        // stop here instead of recording an answer without Spine's anchors.
        throw new SpineDshError("Spine is reloading; retry this turn once it is ready");
      }
      await spine.beginSampling();
      yield* next();
    })();
  }, { prepend: true });
  ctx.effect(() => () => {
    unloading = true;
    lifetime.abort(new SpineDshError("Spine is reloading; retry this turn once it is ready"));
    for (const wait of waitingParents.values()) wait.abort();
    waitingParents.clear();
    // A tool in an active turn can initiate the reload and wait for it.
    // Drain old agent state separately so unloading does not wait on that tool.
    void Promise.allSettled(attaching.values()).then(async () => {
      await Promise.all([...disposers.values()].map(async (dispose) => dispose()));
    }).catch((error: unknown) => ctx.logger.error(error));
  });

  // Ordinary creation, cold resume, and explicit Stop leave recovery parked.
  for (const agent of liveAgents) recoverWaitingParent(agent);
}

function waitingForChildren(agent: Agent): boolean {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (pluginRecordOf(event)?.type !== TREE_RECORD) continue;
    return treeProjection.apply(null, event)?.nodes.some((node) => node.spawn === "pending") === true;
  }
  return false;
}

function lastTurnEnd(agent: Agent) {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn/end") return event.data.reason.kind;
  }
  return undefined;
}

/** A Spine tool only admits its call; its sampling stages and commits it when it settles, before the model reads the result. */
function spineTool(spec: SpineToolSpec, agents: ReadonlyMap<string, SpineAgent>): ToolDefinition {
  const name = `spine_${spec.id}`;
  if (!isSpineToolName(name)) throw new SpineDshError(`unknown Spine tool ${name}`);
  return {
    name,
    description: spec.description,
    parameters: spec.parameters as ToolDefinition["parameters"],
    output: {
      schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
      render: (_args, value) => [{ type: "text", text: (value as { result: string }).result }],
    },
    async execute(args, exec) {
      if (exec.parent !== undefined) throw new SpineDshError(`${name} must be called by the model directly, not from code`);
      const spine = exec.agent === undefined ? undefined : agents.get(exec.agent.id);
      if (spine === undefined) throw new SpineDshError(`${name} was called outside a Spine agent`);
      return { result: spine.admit(name, args as Record<string, unknown>) };
    },
  };
}
