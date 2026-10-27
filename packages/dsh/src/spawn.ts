import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { SpawnTask } from "@spinejit/spine-sdk";
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

/** The live Spine state of every agent in this world, by agent id. */
export interface SpineWorld {
  ctx: Context;
  agents: ReadonlyMap<string, SpineAgent>;
  children: ReadonlyMap<string, SpawnChildren>;
  /** What to check each time a Spawn child agent goes idle, by agent id. */
  idle: Map<string, () => void>;
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
 * One attempt of one Spawn child: a subagent forked from its parent's log just
 * before the sampling that bore it, given its assignment, and run until it
 * returns its memory, goes idle with every child of its own joined and no
 * return, or its parent cancels it. It is judged each time it goes idle.
 */
export async function executeChild(
  world: SpineWorld,
  parent: Agent,
  birth: SpawnBirth,
  peers: readonly SpawnTask[],
  prefixEnd: number,
  signal: AbortSignal,
): Promise<SpawnChildTerminal> {
  const header = parent.session.header;
  const handle = await world.ctx.agents.create({
    sessionId: childSessionId(parent.id, birth.producer),
    parentAgent: parent,
    seed: buildForkSeed(parent.session.snapshotEvents(), SessionSeq(prefixEnd - 1)),
    inheritedEventCount: SessionLogOffset(prefixEnd),
    meta: {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      parentSession: parent.id,
      isSeeded: true,
      origin: "subagent",
      delegationDepth: (header.delegationDepth ?? 0) + 1,
    },
    agentOptions: parent.options,
    signal,
    setup: (agentCtx) => {
      agentCtx.tools.register(returnTool(world.agents));
    },
  });
  const child = handle.agent;
  let judge!: () => void;
  const terminal = new Promise<SpawnChildTerminal>((resolve) => {
    judge = () => {
      const memory = childReturns(child.session.snapshotEvents())[0];
      if (memory !== undefined) resolve({ outcome: "completed", memory });
      else if (signal.aborted) resolve({ outcome: "aborted" });
      // An open birth's arrival is still to come, and it wakes the child.
      else if (world.agents.get(child.id)!.openBirths().length === 0) {
        resolve({ outcome: "errored", diagnostic: `the child went idle without calling ${SPINE_CHILD_RETURN_TOOL}` });
      }
    };
  });
  // Cancelling an idle child starts no turn, so it is judged at once.
  const cancel = () => {
    child.cancel({ kind: "parent" });
    world.children.get(child.id)!.stop();
    if (child.status === "idle") judge();
  };
  world.idle.set(child.id, judge);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
    } else {
      const text = spineChildAssignmentText(birth.task, peers);
      child.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
    }
    return await terminal;
  } finally {
    signal.removeEventListener("abort", cancel);
    world.idle.delete(child.id);
    await world.ctx.sessions.flush(child.session);
    await handle.dispose();
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
function returnTool(agents: ReadonlyMap<string, SpineAgent>): ToolDefinition {
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
