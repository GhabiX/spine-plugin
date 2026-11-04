import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { buildForkSeed, isAppendSurfaceEvent, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { SubagentActivation, SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { SpawnArrival, SpawnTask } from "@spinejit/spine-sdk";
import {
  childState,
  spineChildAssignmentText,
  toArrival,
  type ChildLogItem,
  type SpawnBirth,
  type SpawnChildren,
  type SpawnChildTerminal,
} from "@spinejit/spine-sdk/host";

import type { SpineAgent } from "./agent.js";
import { sourceCharacter, surfaceRole } from "./events.js";

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

/**
 * A child's own log, the events after its inherited prefix, as the Spawn end
 * rule reads it: its source messages, as the Spine core observes them, and
 * the failed requests that end a turn. A cut-off response is no reply
 * already; the turn's end reason adds nothing to it.
 */
function* childLog(events: readonly SessionEvent[]): Generator<ChildLogItem> {
  const spawns = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool/call" && event.data.name === "spine_spawn") {
      spawns.set(event.data.callId, event.data.arguments);
    } else if (event.type === "turn/end" && event.data.reason.kind === "error") {
      yield { type: "error", message: event.data.reason.error.message };
    } else if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source") {
      if (event.type === "tool/result") {
        // A Spawn call whose result succeeded passed admission, so its arguments decode.
        const call = event.data.message.isError === true ? undefined : spawns.get(event.data.message.toolCallId);
        yield call === undefined ? { type: "other" } : { type: "spawn", births: (JSON.parse(call) as { tasks: unknown[] }).tasks.length };
        continue;
      }
      const character = sourceCharacter(event);
      if (character.type === "arrival") yield { type: "arrival" };
      else if (character.type === "message" && character.role === "reply") yield { type: "reply", text: character.content };
      else yield { type: "other" };
    }
  }
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
 * idle after a turn of its own: it arrives once its log ends it, its parent
 * cancelled it, or it has every child of its own joined and its log still
 * does not end it. The arrival is handed over on that idle, before the
 * manager can release the child, so a host that waits for its subagents
 * never sees the parent done with an arrival still to come.
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
    const { open, terminal } = childState(childLog(world.agents.get(id)!.agent.session.ownEvents()));
    if (signal.aborted && terminal?.outcome !== "completed") end({ outcome: "aborted" });
    else if (terminal !== null) end(terminal);
    // An open birth's arrival is still to come, and it wakes the child.
    else if (open === 0) end({ outcome: "errored", diagnostic: "the child went idle without a final reply" });
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
 * After a restart no child runs. A child whose log ends it arrives as it
 * ended; every other open birth arrives aborted. None wakes the agent.
 */
export async function recoverChildren(
  world: SpineWorld,
  parent: Agent,
  births: readonly SpawnBirth[],
  children: SpawnChildren,
): Promise<void> {
  for (const birth of births) {
    const id = childSessionId(parent.id, birth.producer);
    let terminal: SpawnChildTerminal | null = null;
    if ((await world.ctx.sessionPersistence.stat(id)) !== undefined) {
      const handle = await world.ctx.sessionPersistence.open(id, "read");
      try {
        terminal = childState(childLog((await handle.read()).events.slice(handle.inheritedEventCount))).terminal;
      } finally {
        await handle.close();
      }
    }
    children.redeliver(toArrival(birth.producer, terminal
      ?? { outcome: "aborted", diagnostic: "the parent session restarted before this child returned" }));
  }
}
