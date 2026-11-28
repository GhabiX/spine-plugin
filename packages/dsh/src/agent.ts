import type { Message } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-compaction";
import { deriveEventMessage, isAppendSurfaceEvent, pluginRecordOf, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import type { CompactBarrier, EpochOrdinalId, FeatureFlag, SpineProjection, Terminal } from "@spinejit/spine-sdk";
import {
  createHostAdapter,
  isSpineToolName,
  operationFromSpineToolCall,
  spineToolRefusal,
  spineToolResult,
  unarrivedBirths,
  type SpawnBirth,
  type SpineHostAdapter,
  type SpineToolName,
} from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { anchorPrefix, firstText, hasRepairedInlineAnchor, logAnchors, USER_ANCHORS, type UserAnchor } from "./anchors.js";
import {
  arrivalOf,
  beginsSampling,
  compactBarrierOf,
  compactMessage,
  emptySlot,
  endsSampling,
  eventMessage,
  isUserSource,
  samplingSlot,
  sourceCharacter,
  SpineDshError,
  spineText,
  surfaceRole,
  type CompactSummary,
} from "./events.js";
import { applySurfaceEdits, planItems, surfaceEdits, type PlanItem, type SurfaceNode } from "./projection.js";
import { dropReasoning, hasReasoning } from "./reasoning.js";
import { sessionBirth } from "./spawn.js";

export const SPINE_FEATURES: FeatureFlag[] = ["jit", "spawn"];

/**
 * Hands over the births a live commit made and where their sampling began in
 * the log. Resolves once the children are started, or receive non-waking abort
 * arrivals if the user stopped the turn while the Spawn was still queued.
 */
export type BirthHandler = (births: readonly SpawnBirth[], prefixEnd: number, stopped: boolean) => Promise<void>;

/** Hears each projection the agent publishes or commits live; the recovered one is `projection` once `create` returns. */
export type ProjectionHandler = (projection: SpineProjection) => void;

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

/** The checkpoint is durable, but the live Spine state could not follow it. */
export class SpineCompactCommitError extends SpineDshError {}

/** Compaction cannot run now (parallel branches are still out); nothing changed. */
export class SpineCompactBusyError extends SpineDshError {}

export interface SpineCompactOptions {
  /** manual: idle `/compact`; auto: provider-confirmed overflow inside a turn. */
  readonly mode: "manual" | "auto";
  readonly summarize: (messages: readonly Message[]) => Promise<CompactSummary>;
  /** Make the checkpoint durable before Spine changes epochs. */
  readonly flush: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface SpineCompactResult {
  /** The compaction/prune record that prices the shadowed node. */
  readonly pruneSeq: SessionSeq;
  /** The checkpoint user message that carries the barrier. */
  readonly seq: SessionSeq;
  readonly shadowedSeq: SessionSeq;
  readonly shadowedTokenCount: number;
  readonly summary: string;
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

/** How the compaction engine reaches the Spine state of an agent. */
export interface SpineAttachment {
  ensure(agent: Agent): Promise<SpineAgent>;
  readonly signal: AbortSignal;
}

let attachment: SpineAttachment | undefined;

/** The live plugin publishes its attachment; the returned disposer withdraws it. */
export function provideSpineAttachment(value: SpineAttachment): () => void {
  attachment = value;
  return () => { if (attachment === value) attachment = undefined; };
}

export function spineAttachment(): SpineAttachment | undefined {
  return attachment;
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
  readonly agent: Agent;
  readonly #nodePrompt: string;
  readonly #born: BirthHandler;
  readonly #changed: ProjectionHandler;
  #adapter!: SpineHostAdapter;
  /** Every session event seen, by seq. */
  readonly #events = new Map<number, SessionEvent>();
  /** Logged sources the core has not observed yet, in log order. */
  #unobserved: SessionEvent[] = [];
  readonly #sourceSeqs = new Map<string, SessionSeq>();
  /** Each user message's number, by seq: the n-th the user wrote in the log. */
  readonly #userNumbers = new Map<SessionSeq, number>();
  /** User messages numbered for the model: in a user-anchors record, or (0.1.1 and earlier) in their text. */
  readonly #anchored = new Set<SessionSeq>();
  readonly #anchorInText = new Set<SessionSeq>();
  #plan: PlanItem[] | null = null;
  #projection: SpineProjection | null = null;
  /** Births whose arrival is in the log, by producer. */
  readonly #entered = new Set<string>();
  #recovering = false;
  #compactCheckpoint: { seq: SessionSeq; flush: () => Promise<void> } | null = null;
  #sampling: Sampling | null = null;
  #turn = 0;
  #step = 0;
  #fault: unknown = null;

  private constructor(agent: Agent, nodePrompt: string, born: BirthHandler, changed: ProjectionHandler) {
    this.agent = agent;
    this.#nodePrompt = nodePrompt;
    this.#born = born;
    this.#changed = changed;
  }

  static async create(
    agent: Agent,
    configToml: string,
    born: BirthHandler,
    changed: ProjectionHandler,
  ): Promise<SpineAgent> {
    const events = agent.session.snapshotEvents();
    const { thread, continuations } = forkNamespaces(events, agent.id, agent.session.header.parentSession);
    const runtime = createNodeSpineRuntime({ thread, features: SPINE_FEATURES, configToml });
    const spine = new SpineAgent(agent, runtime.nodePrompt(), born, changed);
    spine.#adapter = await createHostAdapter<PlanItem>({
      runtime: runtime.client,
      host: {
        // DSH has no ownership registry. Another writer that rewrites conversation
        // context moves a plan source off the surface, and the projection faults.
        claimOwnership: async () => {},
        // Every fact a commit derives from is already in the session log.
        persistArchive: async () => {},
        persistCompact: (barrier) => spine.#persistCompact(barrier),
        context: {
          materialize: async (context) => planItems(context, (id) => spine.#seqOf(id)),
          publishAtomic: async (context) => {
            spine.#plan = [...context.messages];
            spine.#project(context.projection);
          },
        },
      },
      dispose: () => runtime.dispose(),
    });
    // A resumed session brings its log as seed events, which are never published.
    try {
      await spine.#recover(events, continuations);
    } catch (error) {
      spine.dispose();
      throw error;
    }
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
    if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source" && compactBarrierOf(event) === undefined) {
      this.#unobserved.push(event);
    }
    if (isUserSource(event)) this.#userNumbers.set(event.seq, this.#userNumbers.size + 1);
    const record = pluginRecordOf(event);
    if (record?.type === USER_ANCHORS) {
      for (const { seq } of (record.data as { anchors: UserAnchor[] }).anchors) this.#anchored.add(seq);
    }
    const arrival = arrivalOf(event);
    if (arrival !== null) this.#entered.add(arrival.producer.join("."));
  }

  /** Births still pending whose arrival is not in the log yet. */
  openBirths(): SpawnBirth[] {
    if (this.#projection === null) return [];
    return unarrivedBirths(this.#projection).filter((birth) => !this.#entered.has(birth.producer.join(".")));
  }

  /** A step opened: bring the surface to the published plan. */
  async enterStep(turn: number, step: number): Promise<void> {
    this.#turn = turn;
    this.#step = step;
    await this.#guard(async () => {
      if (this.#plan === null) return;
      applySurfaceEdits(this.agent.session, surfaceEdits(this.#surface(), this.#plan), turn, step);
      dropReasoning(this.agent.session, this.#plan.flatMap((item) =>
        item.type === "source" && item.withoutReasoning ? [item.seq] : []));
    });
  }

  /** A main-loop request is about to stream. Its messages must be the plan; it begins a sampling. */
  async beginSampling(): Promise<void> {
    // A request retried in the same step ends the failed one's stretch.
    await this.settle();
    await this.#guard(async () => {
      await this.#prepare();
      this.#assertSurfaceShowsPlan();
      const session = this.agent.session;
      // The user messages this request is the first to carry, numbered for
      // every later request. DSH built this one from the log right after
      // logging them, with no point between, so it carries them as the user
      // wrote them; the logged messages, which clients show, stay so.
      this.#logPendingAnchors();
      await this.#begin(session.seq);
      // Two empty slots before the response: room for what this sampling
      // puts in front of it (a Next: the closed node's memory). Nothing
      // follows it: a node it opens is described in the call's result.
      // The first marks in the log where the sampling began.
      for (const message of [samplingSlot(), emptySlot()]) {
        session.append("developer/message", { turn: this.#turn, step: this.#step, message }, { surfaceOp: "append" });
      }
    });
  }

  #logPendingAnchors(): void {
    const anchors = [...this.#userNumbers]
      .filter(([seq]) => !this.#anchored.has(seq))
      .map(([seq, anchor]) => ({ seq, anchor }));
    logAnchors(this.agent.session, anchors);
    for (const { seq } of anchors) this.#anchored.add(seq);
  }

  /**
   * Admit one Spine tool call of the current sampling and return its result
   * text, or throw the tool error the model sees. The sampling stages it when
   * it settles, if its logged result is not an error.
   */
  admit(name: SpineToolName, args: Record<string, unknown>): string {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    const sampling = this.#sampling;
    if (sampling === null) throw new SpineDshError(`${name} ran outside a Spine sampling`);
    if (sampling.called !== null) throw new SpineToolLimitError(sampling.called);
    // What the core would refuse at commit is a tool error now, not a fault later.
    const refusal = spineToolRefusal(this.#projection!, name, this.#entered, sessionBirth(this.agent.id), this.#responseCalls(sampling.from));
    if (refusal !== null) throw new SpineDshError(refusal);
    const result = spineToolResult(this.#projection!, name, args, this.#nodePrompt);
    sampling.called = name;
    return result;
  }

  /** Settle the open sampling, if any, over its stretch of the log so far. */
  async settle(): Promise<void> {
    if (this.#sampling !== null) await this.#settle(this.#end(this.#sampling.from));
  }

  /**
   * Replace the live context with one durable checkpoint and move Spine to a
   * new epoch behind it. Manual compaction runs under DSH's idle maintenance
   * lock; automatic compaction runs between a failed request and its retry,
   * where the next request re-enters the step and applies the new plan.
   */
  async compact(options: SpineCompactOptions): Promise<SpineCompactResult | null> {
    const { mode, summarize, flush, signal } = options;
    signal.throwIfAborted();
    await this.settle();
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    if (this.openBirths().length > 0) {
      if (mode === "auto") return null;
      throw new SpineCompactBusyError("Wait for the parallel branches to return before using /compact.");
    }
    const session = this.agent.session;
    if (!hasNewConversation(session)) return null;
    const summary = await summarize(session.deriveMessages());
    signal.throwIfAborted();
    // Check that a durable writer is available before appending the checkpoint.
    await flush();
    signal.throwIfAborted();
    const source = await this.#guard(async () => {
      await this.#observe(Infinity);
      return this.#adapter.sourceSnapshot();
    });
    signal.throwIfAborted();
    return this.#guard(async () => {
      // DSH's default Fork includes replacements after a completed turn, but
      // stops before an appended user message. Keep the checkpoint at the tail
      // of Spine's own surface without replacing any host-owned nodes.
      const nodes = session.surface.nodes;
      let replaced: SessionSeq | undefined;
      for (let index = nodes.length - 1; index >= 0; index--) {
        const candidate = nodes[index]!;
        if (surfaceRole(this.#event(candidate)) === "host") continue;
        replaced = candidate;
        break;
      }
      if (replaced === undefined) throw new SpineDshError("No conversation position for the Spine checkpoint.");
      // A resumed message can still need its number when compact replaces it.
      this.#logPendingAnchors();
      const shadowed = deriveEventMessage(this.#event(replaced));
      const shadowedRange = { start: replaced, end: replaced };
      const shadowedTokenCount = shadowed === null ? 0 : estimateMessage(shadowed);
      const prune = session.append("compaction/prune", { shadowedRange, shadowedSeqs: [replaced], shadowedTokenCount });
      const seq = SessionSeq(session.seq);
      const barrier: CompactBarrier = {
        schema: "spine.compact.barrier.v1",
        thread: source.thread,
        previous_epoch: source.epoch,
        next_epoch: source.epoch + 1,
        boundary: seq - 1,
        replacement_boundaries: [seq],
      };
      session.append("user/message", compactMessage(barrier, summary), {
        surfaceOp: { op: "replace", startSeq: replaced, endSeq: replaced },
        sourceEventSeqs: [replaced],
      });
      this.#compactCheckpoint = { seq, flush };
      try {
        await this.#applyCompact(barrier);
        // DSH only permits developer/message replacements during a running step.
        // enterStep will materialize the checkpoint before the next model request.
      } catch (cause) {
        throw new SpineCompactCommitError("The checkpoint was appended, but compaction could not finish. Check the session after reopening it before retrying.", { cause });
      } finally {
        this.#compactCheckpoint = null;
      }
      return { pruneSeq: SessionSeq(prune.seq), seq, shadowedSeq: replaced, shadowedTokenCount, summary: summary.text };
    });
  }

  async #persistCompact(barrier: CompactBarrier): Promise<void> {
    if (this.#recovering) return;
    const checkpoint = this.#compactCheckpoint;
    if (checkpoint === null || barrier.replacement_boundaries[0] !== checkpoint.seq) {
      throw new SpineDshError("Spine checkpoint does not match the persisted replacement.");
    }
    // The SDK waits for durability before it changes epochs.
    await checkpoint.flush();
  }

  /**
   * A logged barrier as the replaying namespace applies it. A Fork replays its
   * inherited prefix in its own namespace (see forkNamespaces), so the thread
   * the barrier was written in is not the one replaying it. The log positions
   * are the same in every copy; only the namespace and its epoch are local.
   */
  async #replayedBarrier(barrier: CompactBarrier): Promise<CompactBarrier> {
    const source = await this.#adapter.sourceSnapshot();
    if (source.thread === barrier.thread && source.epoch === barrier.previous_epoch) return barrier;
    return { ...barrier, thread: source.thread, previous_epoch: source.epoch, next_epoch: source.epoch + 1 };
  }

  async #applyCompact(barrier: CompactBarrier): Promise<void> {
    await this.#adapter.compact(barrier, { publish: false });
    const source = await this.#adapter.sourceSnapshot();
    for (const cell of source.cells) this.#sourceSeqs.set(sourceKey(cell.source_id), SessionSeq(cell.boundary));
    await this.#adapter.previewAndPublish();
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
  async #recover(events: readonly SessionEvent[], continuations: ReadonlyMap<number, string>): Promise<void> {
    const possibleLegacyAnchors: SessionSeq[] = [];
    this.#recovering = true;
    for (const event of events) {
      const sampling = beginsSampling(event);
      if (sampling) {
        // Older versions logged the anchor in the user text before sampling.
        // Only recognize that format on replay, with a logged Spine sampling
        // and no separate anchor record for that message.
        for (const seq of possibleLegacyAnchors) {
          if (this.#anchored.has(seq)) continue;
          this.#anchored.add(seq);
          this.#anchorInText.add(seq);
        }
        possibleLegacyAnchors.length = 0;
      }
      const barrier = compactBarrierOf(event);
      const nextThread = continuations.get(event.seq);
      if (endsSampling(event) || nextThread !== undefined || barrier !== undefined) await this.#settle(event.seq);
      if (nextThread !== undefined) {
        possibleLegacyAnchors.length = 0;
        await this.#guard(() => this.#continueNamespace(event.seq, nextThread));
      }
      this.accept(event);
      if (barrier !== undefined) {
        await this.#guard(async () => {
          await this.#observe(event.seq);
          await this.#applyCompact(await this.#replayedBarrier(barrier));
        });
      }
      if (isUserSource(event)) {
        const prefix = anchorPrefix(this.#userNumbers.get(event.seq)!);
        if (firstText(eventMessage(event))?.startsWith(prefix)) possibleLegacyAnchors.push(event.seq);
      }
      // Restored logs can contain an inline number even if Spine did not run
      // for that reply. Require an earlier Spine anchor and a queued copy that
      // proves the number was added to the message after the user sent it.
      if (event.type === "assistant/message" && this.#anchored.size > 0) {
        for (const seq of possibleLegacyAnchors) {
          if (this.#anchored.has(seq)) continue;
          const user = this.#events.get(seq);
          if (user?.type === "user/message" && hasRepairedInlineAnchor(this.#events, seq, user.data, this.#userNumbers.get(seq)!)) {
            this.#anchored.add(seq);
            this.#anchorInText.add(seq);
          }
        }
      }
      // With Spine, a user message is numbered before the model answers it.
      if (event.type === "assistant/message" && [...this.#userNumbers.keys()].some((seq) => !this.#anchored.has(seq))) {
        throw new SpineDshError(`session ${this.agent.id} started without Spine: its user messages carry no [U#]`);
      }
      if (sampling) {
        await this.#guard(async () => {
          await this.#prepare();
          await this.#begin(event.seq);
        });
      }
    }
    await this.settle();
    // Observe the entire recovery tail, including pending user sources, repaired
    // inline anchors and DSH's synthetic Fork results, before applying the plan.
    await this.#guard(() => this.#prepare());
    this.#recovering = false;
  }

  #project(projection: SpineProjection): void {
    this.#projection = projection;
    if (!this.#recovering) this.#changed(projection);
  }

  /**
   * Observe the inherited sources and continue in this session's namespace.
   * Births the parent made stay its own to join.
   */
  async #continueNamespace(cut: number, thread: string): Promise<void> {
    await this.#observe(cut);
    const source = await this.#adapter.continueNamespace(thread);
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
    const next = this.agent.session.seq;
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
      const stoppedSpawn = !this.#recovering && call?.name === "spine_spawn" && this.#userStopped(sampling.from, to);
      const olderBirths = stoppedSpawn ? new Set(this.openBirths().map(({ producer }) => producer.join("."))) : null;
      await this.#observe(to);
      const outcome = this.#outcome(sampling.from, to);
      const result = await this.#adapter.finishSampling(outcome.terminal, outcome.inputTokens);
      this.#sampling = null;
      if (result.type !== "committed") return;
      this.#project(result.projection);
      if (!this.#recovering && call?.name === "spine_spawn") {
        const births = this.openBirths().filter(({ producer }) => !olderBirths?.has(producer.join(".")));
        await this.#born(births, sampling.from, stoppedSpawn);
      }
    });
  }

  /** Stop is logged at turn/end, after the sampling's step/end. */
  #userStopped(from: number, to: number): boolean {
    const start = this.#event(from);
    if (start.type !== "developer/message") return false;
    const turn = start.data.turn;
    for (let seq = to; seq < this.agent.session.seq; seq += 1) {
      const event = this.#event(seq);
      if (event.type === "turn/start") return false;
      if (event.type === "turn/end" && event.data.turn === turn) {
        return event.data.reason.kind === "aborted" && event.data.reason.reason.kind === "user";
      }
    }
    return false;
  }

  /** Observe the unobserved sources logged before `to`. */
  async #observe(to: number): Promise<number> {
    const count = this.#unobserved.findIndex((event) => event.seq >= to);
    const events = this.#unobserved.splice(0, count < 0 ? this.#unobserved.length : count);
    if (events.length === 0) return 0;
    const ids = await this.#adapter.observeSources(events.map((event) => sourceCharacter(event, this.#anchorInText.has(event.seq))));
    if (ids.length !== events.length) {
      throw new SpineDshError(`Spine admitted ${ids.length} sources for ${events.length} events`);
    }
    ids.forEach((id, index) => this.#sourceSeqs.set(sourceKey(id), events[index]!.seq));
    return events.length;
  }

  /** Tool calls in the model response logged since `from`, the sampling's start. */
  #responseCalls(from: number): number {
    for (let seq = this.agent.session.seq - 1; seq >= from; seq -= 1) {
      const event = this.#events.get(seq);
      if (event?.type === "assistant/message") {
        return event.data.message.content.filter((block) => block.type === "tool-call").length;
      }
    }
    return 1;
  }

  #seqOf(id: EpochOrdinalId): SessionSeq {
    const seq = this.#sourceSeqs.get(sourceKey(id));
    if (seq === undefined) throw new SpineDshError(`Spine plan names unknown source ${sourceKey(id)}`);
    return seq;
  }

  #surface(): SurfaceNode[] {
    return this.agent.session.surface.nodes.map((seq) => {
      const event = this.#event(seq);
      const role = surfaceRole(event);
      return { seq, role, text: role === "spine" ? spineText(eventMessage(event)) : null };
    });
  }

  /**
   * The request DSH just built is the published plan: no edit pending, and
   * every user message numbered as the plan numbers it, but those it is the
   * first to carry, which it shows as the user wrote them.
   */
  #assertSurfaceShowsPlan(): void {
    const plan = this.#plan!;
    const edits = surfaceEdits(this.#surface(), plan);
    if (edits.length > 0) {
      throw new SpineDshError(`the model request differs from the Spine plan by ${edits.length} surface edits`);
    }
    for (const item of plan) {
      if (item.type !== "source") continue;
      if (item.withoutReasoning) {
        const shown = this.agent.session.deriveEventMessage(this.#event(item.seq));
        if (shown !== null && hasReasoning(shown)) {
          throw new SpineDshError(`source ${item.seq} still shows its reasoning, which the Spine plan leaves out`);
        }
      }
      if (item.anchor === null || !this.#anchored.has(item.seq)) continue;
      const event = this.#event(item.seq);
      const shown = this.agent.session.deriveEventMessage(event);
      const rawText = firstText(eventMessage(event)) ?? "";
      const prefix = anchorPrefix(item.anchor);
      const legacy = this.#anchorInText.has(item.seq);
      const expected = legacy ? rawText : prefix + rawText;
      if ((legacy && !rawText.startsWith(prefix)) || shown === null || firstText(shown) !== expected) {
        throw new SpineDshError(`source ${item.seq} does not show the expected user text for U${item.anchor}`);
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
      const usage = event.data.usage;
      if (usage === undefined) return { terminal };
      // DSH reports uncached, cache-read, and cache-write input separately.
      const inputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      return { terminal, inputTokens };
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

function hasNewConversation(session: Agent["session"]): boolean {
  const events = session.snapshotEvents();
  let checkpoint = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (compactBarrierOf(events[index]!) === undefined) continue;
    checkpoint = events[index]!.seq;
    break;
  }
  return session.surface.nodes.some((seq) => {
    if (seq <= checkpoint) return false;
    const event = events[seq]!;
    if (!isAppendSurfaceEvent(event) || surfaceRole(event) !== "source") return false;
    const message = session.deriveEventMessage(event);
    return message?.content.some((block) => block.type !== "reasoning" &&
      (block.type !== "text" || block.text.trim().length > 0)) ?? false;
  });
}

/** Replay each inherited prefix before continuing in the namespace after its cut. */
function forkNamespaces(events: readonly SessionEvent[], sessionId: string, parentSession?: string) {
  const continuations = new Map<number, string>();
  let thread = sessionId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "session/end-seed" || event.data.inherited !== true) continue;
    const parent = continuations.size === 0 ? parentSession : undefined;
    continuations.set(event.seq, thread);
    // Ordinary Fork does not record the source session ID. A stable namespace
    // per copied segment keeps its pending Spawn work owned by that segment.
    thread = parent ?? `dsh-inherited:${event.seq}`;
  }
  return { thread, continuations };
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}
