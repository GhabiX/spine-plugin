import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { buildForkSeed, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { SubagentActivation, SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { SpawnArrival, SpawnTask } from "@spinejit/spine-sdk";
import {
  SPINE_CHILD_RETURN_TOOL,
  spineChildAssignmentText,
  toArrival,
  type SpawnBirth,
  type SpawnChildren,
  type SpawnChildTerminal,
} from "@spinejit/spine-sdk/host";

import type { SpineAgent } from "./agent.js";
import { SpineDshError } from "./events.js";

/** The subagent provider every Spawn child runs under. */
export const SPINE_SUBAGENT_PROVIDER = "spine";

/** The live Spine state of every agent in this world, by agent id. */
export interface SpineWorld {
  ctx: Context;
  agents: ReadonlyMap<string, SpineAgent>;
  children: ReadonlyMap<string, SpawnChildren>;
  /** What to check each time a Spawn child agent goes idle, by agent id. */
  idle: Map<string, () => void>;
  /** The seed of each Spawn child being started, by its session id. */
  starting: Map<string, readonly SessionEvent[]>;
}

/** A child's session id: fixed by its parent session and birth, so a restarted parent finds it. */
export function childSessionId(parent: string, producer: readonly number[]): SessionId {
  return SessionId(`${parent}:spawn:${producer.join(".")}`);
}

/** The memory each spine_child_return call in a child's log returned, when its result was not an error. */
export function childReturns(events: readonly SessionEvent[]): string[] {
  const calls = new Map<string, string>();
  const accepted: string[] = [];
  for (const event of events) {
    if (event.type === "tool/call" && event.data.name === SPINE_CHILD_RETURN_TOOL) {
      calls.set(event.data.callId, event.data.arguments);
    } else if (event.type === "tool/result" && event.data.message.isError !== true) {
      const call = calls.get(event.data.message.toolCallId);
      if (call !== undefined) accepted.push((JSON.parse(call) as { memory: string }).memory);
    }
  }
  return accepted;
}

/**
 * Spawn children are DSH subagents: the subagent manager creates each one,
 * holds its capacity slot, joins it for the host and tears it down. This
 * provider only hands over the child's seed.
 */
export function spineSubagentProvider(starting: ReadonlyMap<string, readonly SessionEvent[]>): SubagentProvider {
  return {
    name: SPINE_SUBAGENT_PROVIDER,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: true,
    prepareContinuable: (request) => Promise.resolve({ seed: starting.get(request.sessionId)! }),
  };
}

/**
 * One Spawn child: a subagent forked from its parent's log just before the
 * sampling that bore it, given its assignment. It is judged each time it goes
 * idle after a turn of its own: it arrives once it has returned its memory,
 * has every child of its own joined and no return, or its parent cancelled
 * it. The arrival is handed over on that idle, before the manager can release
 * the child, so a host that waits for its subagents never sees the parent
 * done with an arrival still to come.
 */
export async function executeChild(
  world: SpineWorld,
  parent: Agent,
  birth: SpawnBirth,
  peers: readonly SpawnTask[],
  prefixEnd: number,
  signal: AbortSignal,
  arrive: (arrival: SpawnArrival) => void,
  started: () => void,
): Promise<SpawnArrival> {
  const id = childSessionId(parent.id, birth.producer);
  let arrived!: (arrival: SpawnArrival) => void;
  const arrival = new Promise<SpawnArrival>((resolve) => { arrived = resolve; });
  let ended = false;
  const end = (terminal: SpawnChildTerminal) => {
    if (ended) return;
    ended = true;
    const result = toArrival(birth.producer, terminal, signal.aborted);
    arrive(result);
    arrived(result);
  };
  world.idle.set(id, () => {
    const events = world.agents.get(id)!.agent.session.ownEvents();
    if (!events.some((event) => event.type === "turn/end")) return;
    const memory = childReturns(events)[0];
    if (memory !== undefined) end({ outcome: "completed", memory });
    else if (signal.aborted) end({ outcome: "aborted" });
    // An open birth's arrival is still to come, and it wakes the child.
    else if (world.agents.get(id)!.openBirths().length === 0) {
      end({ outcome: "errored", diagnostic: `the child went idle without calling ${SPINE_CHILD_RETURN_TOOL}` });
    }
  });
  // Cancelling an idle child starts no turn, so it arrives at once. A child
  // still being started is cancelled by the manager, through the same signal.
  const cancel = () => {
    const child = world.agents.get(id)?.agent;
    if (child === undefined) return;
    world.children.get(id)?.stop();
    child.cancel({ kind: "parent" });
    if (child.status === "idle") end({ outcome: "aborted" });
  };
  signal.addEventListener("abort", cancel, { once: true });
  world.starting.set(id, buildForkSeed(parent.session.snapshotEvents(), SessionSeq(prefixEnd - 1)));
  let activation: SubagentActivation | undefined;
  try {
    try {
      activation = await world.ctx.subagents.startActivation({
        provider: SPINE_SUBAGENT_PROVIDER,
        label: birth.task.summary,
        childId: id,
        request: { parent, prompt: [{ type: "text", text: spineChildAssignmentText(birth.task, peers) }] },
        signal,
        delivery: "caller",
      });
    } finally {
      world.starting.delete(id);
      started();
    }
    return await arrival;
  } finally {
    signal.removeEventListener("abort", cancel);
    world.idle.delete(id);
    await activation?.dispose();
  }
}

/**
 * After a restart no child runs. A child whose log returned its memory
 * arrives completed; every other open birth arrives aborted. Neither wakes
 * the agent.
 */
export async function recoverChildren(
  world: SpineWorld,
  parent: Agent,
  births: readonly SpawnBirth[],
  children: SpawnChildren,
): Promise<void> {
  for (const birth of births) {
    const id = childSessionId(parent.id, birth.producer);
    let memory: string | undefined;
    if ((await world.ctx.sessionPersistence.stat(id)) !== undefined) {
      const handle = await world.ctx.sessionPersistence.open(id, "read");
      try {
        memory = childReturns((await handle.read()).events)[0];
      } finally {
        await handle.close();
      }
    }
    children.redeliver(toArrival(birth.producer, memory === undefined
      ? { outcome: "aborted", diagnostic: "the parent session restarted before this child returned" }
      : { outcome: "completed", memory }));
  }
}

/** The child's return: accepted once, after the child's own children have arrived; it ends the turn. */
export function returnTool(agents: ReadonlyMap<string, SpineAgent>): ToolDefinition {
  let returned = false;
  return {
    name: SPINE_CHILD_RETURN_TOOL,
    description: "Return the complete model-authored terminal memory for this Spawn child.",
    parameters: {
      type: "object",
      properties: { memory: { type: "string", minLength: 1 } },
      required: ["memory"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
      render: () => [{ type: "text", text: "Spine child memory accepted" }],
    },
    async execute(_args, exec) {
      if (exec.parent !== undefined) {
        throw new SpineDshError(`${SPINE_CHILD_RETURN_TOOL} must be called by the model directly, not from code`);
      }
      if (returned) throw new SpineDshError("this child already returned its memory");
      const spine = exec.agent === undefined ? undefined : agents.get(exec.agent.id);
      if (spine === undefined) throw new SpineDshError(`${SPINE_CHILD_RETURN_TOOL} was called outside a Spine agent`);
      const refusal = spine.returnRefusal();
      if (refusal !== null) throw new SpineDshError(refusal);
      returned = true;
      exec.concludeTurn();
      return { accepted: true };
    },
  };
}
