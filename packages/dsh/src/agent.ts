import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { isAppendSurfaceEvent, type SessionEvent, type SessionSeq } from "@deepseek-ai/dsh-session";
import type { EpochOrdinalId, FeatureFlag, SpineProjection, Terminal } from "@spinejit/spine-sdk";
import {
  childReturnRefusal,
  createHostAdapter,
  isSpineToolName,
  operationFromSpineToolCall,
  spineToolRefusal,
  unarrivedBirths,
  type SpawnBirth,
  type SpineHostAdapter,
  type SpineToolName,
} from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import {
  anchored,
  anchorOf,
  arrivalOf,
  beginsSampling,
  emptySlot,
  endsSampling,
  eventMessage,
  isUserSource,
  samplingSlot,
  sourceCharacter,
  SpineDshError,
  spineText,
  surfaceRole,
} from "./events.js";
import { applySurfaceEdits, planItems, surfaceEdits, type PlanItem, type SurfaceNode } from "./projection.js";

export const SPINE_FEATURES: FeatureFlag[] = ["jit", "spawn"];

/** Hands over the births a live commit made and where their sampling began in the log. */
export type BirthHandler = (births: readonly SpawnBirth[], prefixEnd: number) => void;

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
  /** Log seq of the slot that began the sampling. */
  from: number;
  /** The Spine call its response made, admitted live. */
  called: SpineToolName | null;
}

/** A Spine tool call as logged. */
interface SpineCall {
  name: SpineToolName;
  callId: string;
  args: string;
}

/**
 * The Spine state of one DSH agent. One main-loop model request is one Spine
 * sampling: it begins with a marked empty slot in front of the response, and
 * its stretch of the log runs to the next sampling's slot or to the end of its
 * step. The surface follows the plan the core last published, edited when the
 * next step opens.
 *
 * The session log is the only record of this state. A sampling settles from
 * its stretch alone: the sources in it, the Spine call whose logged result is
 * not an error, and its response. Live and resumed agents settle it with the
 * same code, and when it settles does not change the result.
 */
export class SpineAgent {
  readonly #agent: Agent;
  readonly #nodePrompt: string;
  readonly #born: BirthHandler;
  #adapter!: SpineHostAdapter;
  /** Every session event seen, by seq. */
  readonly #events = new Map<number, SessionEvent>();
  /** Logged sources the core has not observed yet, in log order. */
  #unobserved: SessionEvent[] = [];
  readonly #sourceSeqs = new Map<string, SessionSeq>();
  #userSources = 0;
  #plan: PlanItem[] | null = null;
  #projection: SpineProjection | null = null;
  /** Births whose arrival is in the log, by producer. */
  readonly #entered = new Set<string>();
  #recovering = false;
  #sampling: Sampling | null = null;
  #turn = 0;
  #step = 0;
  #fault: unknown = null;

  private constructor(agent: Agent, nodePrompt: string, born: BirthHandler) {
    this.#agent = agent;
    this.#nodePrompt = nodePrompt;
    this.#born = born;
  }

  static async create(agent: Agent, configToml: string, born: BirthHandler): Promise<SpineAgent> {
    const events = agent.session.snapshotEvents();
    // A forked session's inherited prefix is its parent's namespace.
    const thread = inheritedCut(events) === undefined ? agent.id : agent.session.header.parentSession!;
    const runtime = createNodeSpineRuntime({ thread, features: SPINE_FEATURES, configToml });
    const spine = new SpineAgent(agent, runtime.nodePrompt(), born);
    spine.#adapter = await createHostAdapter<PlanItem>({
      runtime: runtime.client,
      host: {
        // DSH has no ownership registry. Another writer that rewrites conversation
        // context moves a plan source off the surface, and the projection faults.
        claimOwnership: async () => {},
        // Every fact a commit derives from is already in the session log.
        persistArchive: async () => {},
        context: {
          materialize: async (context) => planItems(context, (id) => spine.#seqOf(id), spine.#nodePrompt),
          publishAtomic: async (context) => {
            spine.#plan = [...context.messages];
            spine.#projection = context.projection;
          },
        },
      },
      dispose: () => runtime.dispose(),
    });
    // A resumed session brings its log as seed events, which are never published.
    await spine.#recover(events);
    return spine;
  }

  get projection(): SpineProjection | null {
    return this.#projection;
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  /** Index one event of this agent's session; a new source waits for observation. */
  accept(event: SessionEvent): void {
    if (this.#events.has(event.seq)) return;
    this.#events.set(event.seq, event);
    if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source") this.#unobserved.push(event);
    const arrival = arrivalOf(event);
    if (arrival !== null) this.#entered.add(arrival.producer.join("."));
  }

  /** Why this agent, a Spawn child, may not return its memory yet, or null. */
  returnRefusal(): string | null {
    return childReturnRefusal(this.#projection!, this.#entered);
  }

  /** Births still pending whose arrival is not in the log yet. */
  openBirths(): SpawnBirth[] {
    if (this.#projection === null) return [];
    return unarrivedBirths(this.#projection).filter((birth) => !this.#entered.has(birth.producer.join(".")));
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
    // A request retried in the same step ends the failed one's stretch.
    await this.settle();
    await this.#guard(async () => {
      await this.#prepare();
      this.#assertSurfaceShowsPlan();
      const session = this.#agent.session;
      await this.#begin(session.seq);
      // Two empty slots before the response: room for what this sampling's
      // Open, Close or Next puts in front of it (Next = Close then Open).
      // The first marks in the log where the sampling began.
      for (const message of [samplingSlot(), emptySlot()]) {
        session.append("developer/message", { turn: this.#turn, step: this.#step, message }, { surfaceOp: "append" });
      }
    });
  }

  /**
   * Admit one Spine tool call of the current sampling, or throw the tool error
   * the model sees. The sampling stages it when it settles, if its logged
   * result is not an error.
   */
  admit(name: SpineToolName, args: Record<string, unknown>): void {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    operationFromSpineToolCall(name, args);
    const sampling = this.#sampling;
    if (sampling === null) throw new SpineDshError(`${name} ran outside a Spine sampling`);
    if (sampling.called !== null) throw new SpineToolLimitError(sampling.called);
    // What the core would refuse at commit is a tool error now, not a fault later.
    const refusal = spineToolRefusal(this.#projection!, name, this.#entered);
    if (refusal !== null) throw new SpineDshError(refusal);
    sampling.called = name;
  }

  /** Settle the open sampling, if any, over its stretch of the log so far. */
  async settle(): Promise<void> {
    if (this.#sampling !== null) await this.#settle(this.#end(this.#sampling.from));
  }

  dispose(): void {
    this.#adapter.dispose();
  }

  /**
   * Run the sampling lifecycle over a logged session, in log order: each
   * sampling begins at its marked slot and settles where its stretch ends,
   * or at the end of the log. A forked session continues in its own
   * namespace where its inherited prefix ends.
   */
  async #recover(events: readonly SessionEvent[]): Promise<void> {
    const cut = inheritedCut(events);
    this.#recovering = true;
    for (const event of events) {
      if (endsSampling(event) || event.seq === cut) await this.#settle(event.seq);
      if (event.seq === cut) await this.#guard(() => this.#continueNamespace(event.seq));
      this.accept(event);
      if (isUserSource(event) && anchorOf(eventMessage(event)) === null) {
        throw new SpineDshError(`session ${this.#agent.id} started without Spine: its user messages carry no [U#]`);
      }
      if (beginsSampling(event)) {
        await this.#guard(async () => {
          await this.#prepare();
          await this.#begin(event.seq);
        });
      }
    }
    await this.settle();
    this.#recovering = false;
  }

  /**
   * Observe the inherited sources and continue in this session's namespace.
   * Births the parent made stay its own to join.
   */
  async #continueNamespace(cut: number): Promise<void> {
    await this.#observe(cut);
    const source = await this.#adapter.continueNamespace(this.#agent.id);
    for (const cell of source.cells) this.#sourceSeqs.set(sourceKey(cell.source_id), cell.boundary as SessionSeq);
    await this.#adapter.previewAndPublish();
  }

  /** Observe every logged source and make sure a plan is published for it. */
  async #prepare(): Promise<void> {
    if ((await this.#observe(Infinity)) > 0 || this.#plan === null) await this.#adapter.previewAndPublish();
  }

  async #begin(from: number): Promise<void> {
    await this.#adapter.beginSampling();
    this.#sampling = { from, called: null };
  }

  /** Where the stretch of the sampling that began at `from` ends, as logged so far. */
  #end(from: number): number {
    const next = this.#agent.session.seq;
    for (let seq = from + 1; seq < next; seq += 1) {
      if (endsSampling(this.#event(seq))) return seq;
    }
    return next;
  }

  /** Settle the open sampling with its stretch of the log, which ends before `to`. */
  async #settle(to: number): Promise<void> {
    const sampling = this.#sampling;
    if (sampling === null) return;
    await this.#guard(async () => {
      const call = this.#spineCall(sampling.from, to);
      if (call !== null) {
        const operation = operationFromSpineToolCall(call.name, JSON.parse(call.args) as Record<string, unknown>);
        await this.#adapter.registerExecution(call.callId);
        await this.#adapter.stageExecution(call.callId, call.callId, operation);
        await this.#adapter.finishExecution(call.callId, true);
      }
      await this.#observe(to);
      const outcome = this.#outcome(sampling.from, to);
      const result = await this.#adapter.finishSampling(outcome.terminal, outcome.inputTokens);
      this.#sampling = null;
      if (result.type !== "committed") return;
      this.#projection = result.projection;
      // The children a live Spawn bore start from the log before its sampling.
      if (!this.#recovering && call?.name === "spine_spawn") this.#born(this.openBirths(), sampling.from);
    });
  }

  /** Observe the unobserved sources logged before `to`. */
  async #observe(to: number): Promise<number> {
    const count = this.#unobserved.findIndex((event) => event.seq >= to);
    const events = this.#unobserved.splice(0, count < 0 ? this.#unobserved.length : count);
    if (events.length === 0) return 0;
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

  /** The Spine call in the stretch [from, to) whose logged result is not an error, if any. */
  #spineCall(from: number, to: number): SpineCall | null {
    const calls = new Map<string, SpineCall>();
    for (let seq = from; seq < to; seq += 1) {
      const event = this.#event(seq);
      if (event.type === "tool/call" && isSpineToolName(event.data.name)) {
        calls.set(event.data.callId, { name: event.data.name, callId: event.data.callId, args: event.data.arguments });
      } else if (event.type === "tool/result" && event.data.message.isError !== true) {
        const call = calls.get(event.data.message.toolCallId);
        if (call !== undefined) return call;
      }
    }
    return null;
  }

  /**
   * A sampling ends as its response did: completed when it was logged whole,
   * cancelled when it was interrupted, failed when none was logged.
   */
  #outcome(from: number, to: number): { terminal: Terminal; inputTokens?: number } {
    for (let seq = from; seq < to; seq += 1) {
      const event = this.#event(seq);
      if (event.type !== "assistant/message") continue;
      const terminal: Terminal = event.data.interrupted === true ? "cancelled" : "completed";
      const inputTokens = event.data.usage?.inputTokens;
      return inputTokens === undefined ? { terminal } : { terminal, inputTokens };
    }
    return { terminal: "failed" };
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

/** Where a forked session's inherited prefix ends: its last inherited seed marker. */
function inheritedCut(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "session/end-seed" && event.data.inherited === true) return event.seq;
  }
  return undefined;
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}
