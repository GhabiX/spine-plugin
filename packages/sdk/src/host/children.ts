import type { SpawnArrival, SpawnTask, SpineProjection } from "../index.js";
import { decodeSpineSpawnTasks, type SpineToolName } from "./tools.js";
import { toArrival } from "./spawn.js";

/** A committed birth: the child's id, the task it was given, and where its sampling starts. */
export interface SpawnBirth {
  producer: number[];
  task: SpawnTask;
  start: number;
}

/**
 * Births inside `scope` (a node id prefix; empty = all) this session still has
 * to join. Inherited births are joined by the session that bore them.
 */
export function unarrivedBirths(projection: SpineProjection, scope: readonly number[] = []): SpawnBirth[] {
  return projection.nodes
    .filter((node) => node.spawn === "pending" &&
      scope.every((part, index) => node.id[index] === part))
    .map((node) => {
      const slot = node.memory?.[0];
      if (slot === undefined || !("Birth" in slot)) {
        throw new Error(`Spine birth ${node.id.join(".")} has no birth record`);
      }
      return { producer: [...node.id], task: slot.Birth.task, start: node.start };
    });
}

export function formatBirths(births: readonly SpawnBirth[]): string {
  return births.map((birth) => `${birth.producer.join(".")} (${birth.task.summary})`).join(", ");
}

/**
 * Why the core would refuse this Spine call when its sampling commits, or null.
 * A host refuses the call as a tool error instead, so a model mistake never
 * faults the session. Open and Spawn are refused only for their input.
 * `entered` names, by producer, the births whose arrival is in the
 * sampling's source: the commit joins them before it applies the call.
 */
export function spineToolRefusal(
  projection: SpineProjection,
  name: SpineToolName,
  entered: ReadonlySet<string>,
  /** In a Spawn child, its birth. The child starts in the node it was spawned in, which belongs to its parent. */
  birth: readonly number[] | null,
  /** Tool calls in the model response that made this one, itself included. */
  responseCalls: number,
): string | null {
  if (name !== "spine_close" && name !== "spine_next") return null;
  const cursor = projection.nodes.find((node) => sameId(node.id, projection.cursor));
  if (cursor === undefined) return "Spine cursor is missing from the derived tree";
  // A Spawn child starts in the node it was spawned in, the root included: it is its parent's.
  if (birth !== null && sameId(cursor.id, birth.slice(0, -1))) {
    return `Spine node ${cursor.id.join(".")} belongs to the session that spawned you: a Spawn child closes only the nodes it opened. End your work with a final reply; that reply is your result.`;
  }
  if (cursor.kind === "RootEpoch") return "You are at the root: no Spine node is open, so there is none to close.";
  const pending = unarrivedBirths(projection, projection.cursor).filter((birth) => !entered.has(birth.producer.join(".")));
  if (pending.length > 0) {
    return `Spawned children ${formatBirths(pending)} have not arrived. Each result arrives as its own message; close this node after they have arrived.`;
  }
  // The memory is written before the calls beside it return, and their results fold away with the node.
  if (name === "spine_close" && responseCalls > 1) {
    return "spine_close must be the only tool call in its response: the node's memory is written before the other calls return, and their results fold away with the node. Call spine_close again on its own.";
  }
  return null;
}

/**
 * The result of an admitted Spine call as the model reads it: what the call
 * has done once its sampling commits, which is before the model reads it.
 * The call is the only Spine call in its response, so the cursor at
 * admission fixes its effect. An opened node's descriptor follows the result;
 * spawned children start when the turn ends.
 */
export function spineToolResult(projection: SpineProjection, name: SpineToolName, input: Record<string, unknown>): string {
  if (name === "spine_spawn") {
    const tasks = decodeSpineSpawnTasks(input);
    return `Spine Spawn accepted ${tasks.length} tasks. Each child starts when this turn ends, and its result arrives later as its own message. This node cannot close until all of them have arrived.`;
  }
  if (name === "spine_open") return "The node is open.";
  const cursor = projection.nodes.find((node) => sameId(node.id, projection.cursor));
  if (cursor === undefined) throw new Error("Spine cursor is missing from the derived tree");
  const closed = `Node ${cursor.id.join(".")} is closed and its memory is recorded.`;
  if (name === "spine_next") return `${closed} The next node is open.`;
  const parent = projection.nodes.find((node) => cursor.parent !== null && sameId(node.id, cursor.parent));
  if (parent === undefined) throw new Error(`Spine node ${cursor.id.join(".")} has no parent in the derived tree`);
  return parent.kind === "RootEpoch" ? `${closed} You are back at the root.` : `${closed} You are back in node ${parent.id.join(".")}.`;
}

function sameId(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export type SpawnChildRunner = (signal: AbortSignal) => Promise<SpawnArrival>;

/** Hands an arrival to the parent session; `wake` starts a turn when the agent is idle. */
export type DeliverArrival = (arrival: SpawnArrival, wake: boolean) => void;

interface ChildRun {
  controller: AbortController;
  /** Whether the arrival starts a turn, read when it is handed over. */
  wake: () => boolean;
  stopped: boolean;
  disposed: boolean;
}

/**
 * The children one parent session owns. A child is tracked from launch until
 * its arrival is admitted: after the run ends its arrival is held, so a birth
 * is never started twice and an arrival the host dropped can be handed over again.
 */
export class SpawnChildren {
  readonly #deliver: DeliverArrival;
  readonly #runs = new Map<string, ChildRun>();
  readonly #handed = new Map<string, SpawnArrival>();
  #waiters: (() => void)[] = [];

  constructor(deliver: DeliverArrival) {
    this.#deliver = deliver;
  }

  get running(): number {
    return this.#runs.size;
  }

  /** Starts every birth not yet started; births launched together are peers. */
  launch(
    births: readonly SpawnBirth[],
    run: (birth: SpawnBirth, peers: readonly SpawnTask[], signal: AbortSignal) => Promise<SpawnArrival>,
  ): void {
    const fresh = births.filter((birth) => !this.#tracked(birth.producer));
    const peers = fresh.map((birth) => birth.task);
    for (const birth of fresh) this.start(birth, (signal) => run(birth, peers, signal));
  }

  /**
   * Starts one child with its own runner, unless it is already tracked. Its
   * arrival wakes the parent if `wake` holds when it is handed over, unless
   * the user stopped it.
   */
  start(birth: SpawnBirth, runner: SpawnChildRunner, wake: () => boolean = () => true): void {
    const key = birth.producer.join(".");
    if (this.#tracked(birth.producer)) return;
    const run: ChildRun = { controller: new AbortController(), wake, stopped: false, disposed: false };
    this.#runs.set(key, run);
    void runner(run.controller.signal)
      .catch((cause: unknown) => toArrival(birth.producer, {
        outcome: "errored",
        diagnostic: cause instanceof Error ? cause.message : String(cause),
      }, run.controller.signal.aborted))
      .then((arrival) => {
        if (this.#runs.get(key) === run) this.#end(key, run, arrival);
      });
  }

  /**
   * Hands over a running child's arrival now, ahead of its runner, for a host
   * that releases the child as soon as it is done: the arrival is in the
   * parent before the host can see no child running. The runner's own result
   * is then dropped.
   */
  arrive(arrival: SpawnArrival): void {
    const key = arrival.producer.join(".");
    const run = this.#runs.get(key);
    if (run !== undefined) this.#end(key, run, arrival);
  }

  /** Hands over an arrival that needs no run, such as one recovered from a child's record. */
  redeliver(arrival: SpawnArrival): void {
    const key = arrival.producer.join(".");
    if (this.#tracked(arrival.producer)) return;
    this.#handed.set(key, arrival);
    this.#deliver(arrival, false);
  }

  /**
   * The agent settled. `open` are the births still pending whose arrival is
   * not in the session's source; arrivals for any other birth reached the
   * source and are forgotten. A stopped agent may have dropped queued
   * messages, so the rest are handed over again without waking it: an arrival
   * enters the source at most once.
   */
  settle(open: readonly SpawnBirth[], aborted: boolean): void {
    const keys = new Set(open.map((birth) => birth.producer.join(".")));
    for (const key of [...this.#handed.keys()]) {
      if (!keys.has(key)) this.#handed.delete(key);
    }
    if (!aborted) return;
    for (const arrival of this.#handed.values()) this.#deliver(arrival, false);
  }

  /** User Stop: cancel every child; the aborted arrivals do not wake the agent. */
  stop(): void {
    for (const run of this.#runs.values()) {
      run.stopped = true;
      run.controller.abort();
    }
  }

  /** Session change: cancel every child and deliver nothing; recovery owns them now. */
  dispose(): void {
    for (const run of this.#runs.values()) {
      run.disposed = true;
      run.controller.abort();
    }
    this.#notify();
  }

  /** Resolves when some running child has been handed over, or at once when none runs. */
  next(): Promise<void> {
    if (this.#runs.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #end(key: string, run: ChildRun, arrival: SpawnArrival): void {
    this.#runs.delete(key);
    if (!run.disposed) {
      this.#handed.set(key, arrival);
      this.#deliver(arrival, !run.stopped && run.wake());
    }
    this.#notify();
  }

  #tracked(producer: readonly number[]): boolean {
    const key = producer.join(".");
    return this.#runs.has(key) || this.#handed.has(key);
  }

  #notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
