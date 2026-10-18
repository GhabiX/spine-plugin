/**
 * A Spawn child is a separate `pi -p` process. Its parent stops it only through
 * an in-process AbortSignal or timeout, and handles its own SIGTERM by cleaning
 * up children; none of that runs when the parent is SIGKILLed, OOM-killed or
 * crashes. The child therefore binds its lifetime to the parent: once its parent
 * process is no longer the one that spawned it (it was reparented), it is
 * orphaned and must end.
 */
export interface ParentWatchOptions {
  /** PID of the spawning parent, passed by the parent itself. */
  readonly expectedParent: number;
  readonly ppid: () => number;
  readonly onOrphaned: () => void;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;

/** Calls `onOrphaned` once when the parent goes away; returns a stop function. */
export function watchParent(options: ParentWatchOptions): () => void {
  // Compare against the parent's own PID, not the first ppid read here: the
  // parent may already be gone and the child adopted before this runs.
  if (options.ppid() !== options.expectedParent) {
    options.onOrphaned();
    return () => {};
  }
  const timer = setInterval(() => {
    if (options.ppid() === options.expectedParent) return;
    clearInterval(timer);
    options.onOrphaned();
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
