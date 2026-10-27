import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import {
  appendPluginRecord,
  isAppendSurfaceEvent,
  pluginRecordOf,
  type SessionEvent,
  type SessionSeq,
} from "@deepseek-ai/dsh-session";
import type { EpochOrdinalId, FeatureFlag, ReplayItem, SamplingArchiveRecord, Terminal } from "@spinejit/spine-sdk";
import {
  archiveRecordId,
  createHostAdapter,
  operationFromSpineToolCall,
  SPINE_HOST_PROTOCOL_SCHEMA,
  type HostArchiveEnvelope,
  type SpineHostAdapter,
  type SpineToolName,
} from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import {
  anchored,
  anchorOf,
  emptySlot,
  eventMessage,
  isUserSource,
  sourceCharacter,
  SpineDshError,
  spineText,
  surfaceRole,
} from "./events.js";
import { applySurfaceEdits, planItems, surfaceEdits, type PlanItem, type SurfaceNode } from "./projection.js";

declare module "@deepseek-ai/dsh-session" {
  interface PluginRecordMap {
    /** One Spine sampling archive record, durable before its commit takes effect. */
    "plugin:spinejit/archive": HostArchiveEnvelope;
  }
}

const ARCHIVE_RECORD = "plugin:spinejit/archive";

export const SPINE_FEATURES: FeatureFlag[] = ["jit"];

/**
 * One model response carries at most one Spine operation (the core admits one
 * per sampling). A second call is refused before it runs; the model sees a tool error.
 */
export class SpineToolLimitError extends Error {
  constructor(staged: SpineToolName) {
    super(`only one Spine tool call is allowed per model response; ${staged} already ran in this one`);
    this.name = "SpineToolLimitError";
  }
}

interface Sampling {
  /** First log seq after the sampling began. */
  from: number;
  staged: SpineToolName | null;
}

/**
 * The Spine state of one DSH agent. One main-loop model request is one Spine
 * sampling; it settles at the next pre-step, at turn-stopping, at a request
 * error, or when the agent is disposed. The surface follows the plan the core
 * last published, edited when the next step opens. The session log alone
 * rebuilds this state: its sources and archive records, in log order, are
 * exactly what the core observed and committed.
 */
export class SpineAgent {
  readonly #agent: Agent;
  readonly #nodePrompt: string;
  #adapter!: SpineHostAdapter;
  /** Every session event seen, by seq. */
  readonly #events = new Map<number, SessionEvent>();
  /** Logged sources the core has not observed yet. */
  #unobserved: SessionEvent[] = [];
  readonly #sourceSeqs = new Map<string, SessionSeq>();
  #userSources = 0;
  #plan: PlanItem[] | null = null;
  #sampling: Sampling | null = null;
  #turn = 0;
  #step = 0;
  #fault: unknown = null;

  private constructor(agent: Agent, nodePrompt: string) {
    this.#agent = agent;
    this.#nodePrompt = nodePrompt;
  }

  static async create(agent: Agent, configToml: string): Promise<SpineAgent> {
    const runtime = createNodeSpineRuntime({ thread: agent.id, features: SPINE_FEATURES, configToml });
    const spine = new SpineAgent(agent, runtime.nodePrompt());
    spine.#adapter = await createHostAdapter<PlanItem>({
      runtime: runtime.client,
      host: {
        // DSH has no ownership registry. Another writer that rewrites conversation
        // context moves a plan source off the surface, and the projection faults.
        claimOwnership: async () => {},
        persistArchive: async (entry) => {
          appendPluginRecord(agent.session, ARCHIVE_RECORD, entry);
        },
        context: {
          materialize: async (context) => planItems(context, (id) => spine.#seqOf(id), spine.#nodePrompt),
          publishAtomic: async (context) => {
            spine.#plan = [...context.messages];
          },
        },
      },
      dispose: () => runtime.dispose(),
    });
    // A resumed session brings its log as seed events, which are never published.
    const events = agent.session.snapshotEvents();
    for (const event of events) spine.#events.set(event.seq, event);
    if (agent.session.surface.nodes.length > 0) await spine.#recover(events);
    return spine;
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  /** Index one event of this agent's session; a new source waits for observation. */
  accept(event: SessionEvent): void {
    if (this.#events.has(event.seq)) return;
    this.#events.set(event.seq, event);
    if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source") this.#unobserved.push(event);
  }

  /** Number the user messages entering a step `[U<n>]` before they are logged. */
  anchor(decision: PreStepDecision): PreStepDecision {
    if (decision.kind !== "enter") return decision;
    let anchor = this.#userSources + this.#unobserved.filter(isUserSource).length;
    return {
      ...decision,
      messages: decision.messages.map((message) =>
        message.source.kind === "user" ? anchored(message, ++anchor) : message),
    };
  }

  /** A step opened: bring the surface to the published plan. */
  async enterStep(turn: number, step: number): Promise<void> {
    this.#turn = turn;
    this.#step = step;
    await this.#guard(async () => {
      if (this.#plan === null) return;
      applySurfaceEdits(this.#agent.session, surfaceEdits(this.#surface(), this.#plan), turn, step);
    });
  }

  /** A main-loop request is about to stream. Its messages must be the plan; it begins a sampling. */
  async beginSampling(): Promise<void> {
    await this.#guard(async () => {
      if (this.#sampling !== null) {
        throw new SpineDshError("a model request started before the previous Spine sampling settled");
      }
      if ((await this.#observe()) > 0 || this.#plan === null) await this.#adapter.previewAndPublish();
      this.#assertSurfaceShowsPlan();
      await this.#adapter.beginSampling();
      const session = this.#agent.session;
      this.#sampling = { from: session.seq, staged: null };
      // Two empty slots before the response: room for what this sampling's
      // Open, Close or Next puts in front of it (Next = Close then Open).
      for (let slot = 0; slot < 2; slot += 1) {
        session.append("developer/message", { turn: this.#turn, step: this.#step, message: emptySlot() }, { surfaceOp: "append" });
      }
    });
  }

  /** Stage one Spine tool call of the current sampling. */
  async stage(name: SpineToolName, callId: string, args: Record<string, unknown>): Promise<void> {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    const operation = operationFromSpineToolCall(name, args);
    const sampling = this.#sampling;
    if (sampling === null) throw new SpineDshError(`${name} ran outside a Spine sampling`);
    if (sampling.staged !== null) throw new SpineToolLimitError(sampling.staged);
    sampling.staged = name;
    await this.#guard(async () => {
      await this.#adapter.registerExecution(callId);
      await this.#adapter.stageExecution(callId, callId, operation);
      await this.#adapter.finishExecution(callId, true);
    });
  }

  /** Settle the open sampling, if any, from what the log says happened to it. */
  async settle(): Promise<void> {
    const sampling = this.#sampling;
    if (sampling === null) return;
    await this.#guard(async () => {
      await this.#observe();
      const outcome = this.#outcome(sampling);
      await this.#adapter.finishSampling(outcome.terminal, outcome.inputTokens);
      this.#sampling = null;
    });
  }

  dispose(): void {
    this.#adapter.dispose();
  }

  /** Replay the log into the core: each source as observed, each archive record as persisted. */
  async #recover(events: readonly SessionEvent[]): Promise<void> {
    const inputs: ReplayItem[] = [];
    const sources = new Set<number>();
    for (const event of events) {
      const record = pluginRecordOf(event);
      if (record?.type === ARCHIVE_RECORD) {
        inputs.push({ type: "archive", record: archivedSampling(record.data) });
        continue;
      }
      if (!isAppendSurfaceEvent(event) || surfaceRole(event) !== "source") continue;
      if (isUserSource(event)) {
        if (anchorOf(eventMessage(event)) === null) {
          throw new SpineDshError(`session ${this.#agent.id} started without Spine: its user messages carry no [U#]`);
        }
        this.#userSources += 1;
      }
      inputs.push({ type: "source", character: sourceCharacter(event) });
      sources.add(event.seq);
    }
    await this.#adapter.replayWithSources(inputs, async (snapshot) => {
      for (const cell of snapshot.cells) {
        if (!sources.has(cell.boundary)) throw new SpineDshError(`Spine replayed source ${cell.boundary}, which is not a logged source`);
        this.#sourceSeqs.set(sourceKey(cell.source_id), cell.boundary as SessionSeq);
      }
    });
  }

  async #observe(): Promise<number> {
    const events = this.#unobserved;
    if (events.length === 0) return 0;
    this.#unobserved = [];
    const ids = await this.#adapter.observeSources(events.map(sourceCharacter));
    if (ids.length !== events.length) {
      throw new SpineDshError(`Spine admitted ${ids.length} sources for ${events.length} events`);
    }
    ids.forEach((id, index) => this.#sourceSeqs.set(sourceKey(id), events[index]!.seq));
    this.#userSources += events.filter(isUserSource).length;
    return events.length;
  }

  #seqOf(id: EpochOrdinalId): SessionSeq {
    const seq = this.#sourceSeqs.get(sourceKey(id));
    if (seq === undefined) throw new SpineDshError(`Spine plan names unknown source ${sourceKey(id)}`);
    return seq;
  }

  #surface(): SurfaceNode[] {
    return this.#agent.session.surface.nodes.map((seq) => {
      const event = this.#event(seq);
      const role = surfaceRole(event);
      return { seq, role, text: role === "spine" ? spineText(eventMessage(event)) : null };
    });
  }

  /** The request DSH just built is the published plan: no edit pending, and every anchor as numbered. */
  #assertSurfaceShowsPlan(): void {
    const plan = this.#plan!;
    const edits = surfaceEdits(this.#surface(), plan);
    if (edits.length > 0) {
      throw new SpineDshError(`the model request differs from the Spine plan by ${edits.length} surface edits`);
    }
    for (const item of plan) {
      if (item.type !== "source" || item.anchor === null) continue;
      const logged = anchorOf(eventMessage(this.#event(item.seq)));
      if (logged !== item.anchor) {
        throw new SpineDshError(`source ${item.seq} is U${item.anchor} in the Spine plan but logged as U${logged}`);
      }
    }
  }

  #event(seq: number): SessionEvent {
    const event = this.#events.get(seq);
    if (event === undefined) throw new SpineDshError(`session event ${seq} was never seen`);
    return event;
  }

  /** Cancelled if the turn aborted; completed if a response was logged; failed otherwise. */
  #outcome(sampling: Sampling): { terminal: Terminal; inputTokens?: number } {
    let terminal: Terminal = "failed";
    let inputTokens: number | undefined;
    for (let seq = sampling.from; seq < this.#agent.session.seq; seq += 1) {
      const event = this.#events.get(seq);
      if (event?.type === "assistant/message") {
        terminal = event.data.interrupted === true ? "cancelled" : "completed";
        inputTokens = event.data.usage?.inputTokens;
      } else if (event?.type === "turn/end" && event.data.reason.kind === "aborted") {
        terminal = "cancelled";
      }
    }
    return inputTokens === undefined ? { terminal } : { terminal, inputTokens };
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    try {
      return await operation();
    } catch (cause) {
      this.#fault ??= cause;
      throw new SpineDshError("Spine context fault", { cause });
    }
  }
}

/** A stored archive record, checked as its owner must check restored plugin data. */
function archivedSampling(data: unknown): SamplingArchiveRecord {
  const entry = data as Partial<HostArchiveEnvelope> | null;
  if (entry?.schema !== SPINE_HOST_PROTOCOL_SCHEMA || entry.record === undefined ||
    entry.durabilityId !== archiveRecordId(entry.record)) {
    throw new SpineDshError("a stored Spine archive record is malformed");
  }
  return entry.record;
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}
