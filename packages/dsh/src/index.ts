import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { isSpineToolName, loadSpineConfigToml, runSpawnChild, SpawnChildren } from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime, type SpineToolSpec } from "@spinejit/spine-sdk/node";

import { SPINE_FEATURES, SpineAgent } from "./agent.js";
import { arrivalMessage, SpineDshError } from "./events.js";
import { executeChild, recoverChildren, type SpineWorld } from "./spawn.js";

/** The Cordis plugin DeepSeek Harness loads, by package name, from a bundle. */
export const name = "spinejit";
export const inject = ["agents", "llm", "sessionPersistence", "sessions", "systemPrompt", "tools"];

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

  const agents = new Map<string, SpineAgent>();
  const children = new Map<string, SpawnChildren>();
  const world: SpineWorld = { ctx, agents, children, idle: new Map() };
  ctx.systemPrompt.section({ name: "spinejit", order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK"), text: prompt });
  for (const tool of tools) ctx.tools.register(spineTool(tool, agents));

  ctx.on("session/event", (session, event) => {
    agents.get(session.id)?.accept(event);
  });
  ctx.on("agent/created", async ({ agent }) => {
    // An arrival enters only the session that bore it, once, while its birth is open.
    const own = new SpawnChildren((arrival, wake) => {
      const producer = arrival.producer.join(".");
      if (!agents.get(agent.id)?.openBirths().some((birth) => birth.producer.join(".") === producer)) return;
      if (wake) agent.steer(arrivalMessage(arrival));
      else agent.inject(arrivalMessage(arrival));
    });
    const spine = await SpineAgent.create(agent, configToml, (births, prefixEnd) => {
      own.launch(births, (birth, peers, signal) => runSpawnChild({
        producer: birth.producer,
        task: birth.task,
        signal,
        executor: { execute: () => executeChild(world, agent, birth, peers, prefixEnd, signal) },
      }));
    });
    agents.set(agent.id, spine);
    children.set(agent.id, own);
    await recoverChildren(world, agent, spine.openBirths(), own);
    agent.ctx.effect(() => async () => {
      // Its children stop and deliver nothing; a resumed session recovers them.
      own.dispose();
      // A cancelled turn reaches no stopping or error hook; it settles here or at the next pre-step.
      await agent.whenIdle();
      try {
        await spine.settle();
      } finally {
        agents.delete(agent.id);
        children.delete(agent.id);
        spine.dispose();
      }
    });
  });
  ctx.on("agent/status", ({ agent, status }) => {
    const spine = agents.get(agent.id);
    const own = children.get(agent.id);
    if (status !== "idle" || spine === undefined || own === undefined) return;
    // A stopped agent stops its children; their arrivals do not wake it.
    const aborted = lastTurnAborted(agent);
    if (aborted) own.stop();
    own.settle(spine.openBirths(), aborted);
    world.idle.get(agent.id)?.();
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    const spine = agents.get(payload.agent.id);
    if (spine === undefined) return next();
    await spine.settle();
    return spine.anchor(await next());
  }, { prepend: true });
  ctx.on("agent/request", async (payload, next) => {
    await agents.get(payload.agent.id)?.enterStep(payload.turn, payload.step);
    return next();
  }, { prepend: true });
  ctx.on("agent/turn-stopping", async ({ agent }) => {
    await agents.get(agent.id)?.settle();
  });
  ctx.on("agent/request-error", async (payload, next) => {
    await agents.get(payload.agent.id)?.settle();
    return next();
  }, { prepend: true });
  ctx.on("llm/stream", (request, next) => {
    const spine = isAgentLoopRequest(request) && request.sessionId !== undefined ? agents.get(request.sessionId) : undefined;
    if (spine === undefined) return next();
    return (async function* () {
      await spine.beginSampling();
      yield* next();
    })();
  }, { prepend: true });
}

function lastTurnAborted(agent: Agent): boolean {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn/end") return event.data.reason.kind === "aborted";
  }
  return false;
}

/** A Spine tool only stages its operation; the sampling commits it when it settles. */
function spineTool(spec: SpineToolSpec, agents: ReadonlyMap<string, SpineAgent>): ToolDefinition {
  const name = `spine_${spec.id}`;
  if (!isSpineToolName(name)) throw new SpineDshError(`unknown Spine tool ${name}`);
  return {
    name,
    description: spec.description,
    parameters: spec.parameters as ToolDefinition["parameters"],
    output: {
      schema: { type: "object", properties: { staged: { type: "string" } }, required: ["staged"] },
      render: () => [{ type: "text", text: `Spine ${name} staged` }],
    },
    async execute(args, exec) {
      if (exec.parent !== undefined) throw new SpineDshError(`${name} must be called by the model directly, not from code`);
      const spine = exec.agent === undefined ? undefined : agents.get(exec.agent.id);
      if (spine === undefined) throw new SpineDshError(`${name} was called outside a Spine agent`);
      await spine.stage(name, exec.callId, args as Record<string, unknown>);
      return { staged: name };
    },
  };
}
