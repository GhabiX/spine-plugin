import type { Context } from "@deepseek-ai/cordis";
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { isSpineToolName, loadSpineConfigToml } from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime, type SpineToolSpec } from "@spinejit/spine-sdk/node";

import { SPINE_FEATURES, SpineAgent } from "./agent.js";
import { SpineDshError } from "./events.js";

/** The Cordis plugin DeepSeek Harness loads, by package name, from a bundle. */
export const name = "spinejit";
export const inject = ["agents", "llm", "sessions", "systemPrompt", "tools"];

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
  ctx.systemPrompt.section({ name: "spinejit", order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK"), text: prompt });
  for (const tool of tools) ctx.tools.register(spineTool(tool, agents));

  ctx.on("session/event", (session, event) => {
    agents.get(session.id)?.accept(event);
  });
  ctx.on("agent/created", async ({ agent }) => {
    const spine = await SpineAgent.create(agent, configToml);
    agents.set(agent.id, spine);
    agent.ctx.effect(() => async () => {
      // A cancelled turn reaches no stopping or error hook; it settles here or at the next pre-step.
      await agent.whenIdle();
      try {
        await spine.settle();
      } finally {
        agents.delete(agent.id);
        spine.dispose();
      }
    });
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
