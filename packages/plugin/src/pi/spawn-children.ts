import type { SpawnArrival, SpawnTask, SpineProjection } from "@spinejit/spine-sdk";

import { toArrival } from "../spawn.js";

/** A committed birth: the child's id, the task it was given, and where its sampling starts. */
export interface PiSpawnBirth {
  producer: number[];
  task: SpawnTask;
  start: number;
}

/**
 * Births inside `scope` (a node id prefix; empty = all) this session still has
 * to join. Inherited births are joined by the session that bore them.
 */
export function unarrivedBirths(projection: SpineProjection, scope: readonly number[] = []): PiSpawnBirth[] {
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

export type SpawnChildRunner = (signal: AbortSignal) => Promise<SpawnArrival>;

/** Hands an arrival to the parent session; `wake` starts a turn when the agent is idle. */
export type DeliverArrival = (arrival: SpawnArrival, wake: boolean) => void;

interface ChildRun {
  controller: AbortController;
  wake: boolean;
  disposed: boolean;
}

/**
 * The children one parent session owns. A child is tracked from launch until
 * its arrival is admitted: after the run ends its arrival is held, so a birth
 * is never started twice and an arrival Pi dropped can be handed over again.
 */
export class PiSpawnChildren {
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
    births: readonly PiSpawnBirth[],
    run: (birth: PiSpawnBirth, peers: readonly SpawnTask[], signal: AbortSignal) => Promise<SpawnArrival>,
  ): void {
    const fresh = births.filter((birth) => !this.#tracked(birth.producer));
    const peers = fresh.map((birth) => birth.task);
    for (const birth of fresh) this.start(birth, (signal) => run(birth, peers, signal));
  }

  /** Starts one child with its own runner, unless it is already tracked. */
  start(birth: PiSpawnBirth, runner: SpawnChildRunner, wake = true): void {
    const key = birth.producer.join(".");
    if (this.#tracked(birth.producer)) return;
    const run: ChildRun = { controller: new AbortController(), wake, disposed: false };
    this.#runs.set(key, run);
    void runner(run.controller.signal)
      .catch((cause: unknown) => toArrival(birth.producer, {
        outcome: "errored",
        diagnostic: cause instanceof Error ? cause.message : String(cause),
      }, run.controller.signal.aborted))
      .then((arrival) => {
        this.#runs.delete(key);
        if (!run.disposed) {
          this.#handed.set(key, arrival);
          this.#deliver(arrival, run.wake);
        }
        this.#notify();
      });
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
   * source and are forgotten. After a Stop, Pi drops queued steering messages,
   * so the rest never reached it and are handed over again without waking the
   * agent: an arrival enters the source at most once.
   */
  settle(open: readonly PiSpawnBirth[], aborted: boolean): void {
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
      run.wake = false;
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
