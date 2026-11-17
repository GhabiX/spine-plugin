// The Spine tree each agent shows, kept two ways. The agent's session log gets
// a record whenever what its tree shows changes; a session projection folds
// the records for clients. The terminal reads the shown session's tree from
// this store.
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { SpineProjection } from "@spinejit/spine-sdk";
import { z } from "zod";

import { beginsSampling } from "./events.js";
import { sessionBirth } from "./spawn.js";
import { spineTreeOf, TREE_PROJECTION, TREE_RECORD, type SpineTree, type SpineView } from "./tree.js";

declare module "@deepseek-ai/dsh-session" {
  interface PluginRecordMap {
    "plugin:spinejit/tree": SpineTree;
  }
}

const treeSchema: z.ZodType<SpineTree> = z.object({
  cursor: z.string(),
  nodes: z.array(z.object({
    nodeId: z.string(),
    parentId: z.string().nullable(),
    kind: z.enum(["RootEpoch", "Task", "Spawn"]),
    status: z.enum(["Live", "Opened", "Closed", "Compacted"]),
    summary: z.string().nullable(),
    spawn: z.union([
      z.enum(["pending", "inherited"]),
      z.object({ arrived: z.enum(["completed", "errored", "aborted"]) }),
    ]).nullable(),
  })),
});

const stateSchema = z.object({
  /** The tree of the latest readable record, null before the first. */
  tree: treeSchema.nullable(),
  /** See {@link SpineView.legacy}. */
  legacy: z.boolean(),
  /** A Spine sampling has been folded, so no later response can make the log legacy. */
  sampling: z.boolean(),
});

type State = z.infer<typeof stateSchema>;

const viewSchema = z.object({
  tree: treeSchema.nullable(),
  legacy: z.boolean(),
});

/**
 * The session projection clients read: the tree the log last recorded, and
 * whether the log began before this plugin did. A record this build cannot
 * read leaves the tree as it was.
 */
export const treeProjection = {
  key: TREE_PROJECTION,
  stateVersion: 2,
  stateSchema,
  init: (): State => ({ tree: null, legacy: false, sampling: false }),
  apply(state: State, event: SessionEvent): State {
    const record = pluginRecordOf(event);
    const parsed = record?.type === TREE_RECORD ? treeSchema.safeParse(record.data) : null;
    const tree = parsed?.success === true ? parsed.data : state.tree;
    // A response logged with no sampling slot in front of it is history this
    // plugin never observed. A slot folded first settles the other way, for good.
    const legacy = state.legacy || (!state.sampling && event.type === "assistant/message");
    const sampling = state.sampling || beginsSampling(event);
    if (tree === state.tree && legacy === state.legacy && sampling === state.sampling) return state;
    return { tree, legacy, sampling };
  },
  wire: { viewSchema, view: (state: State): SpineView => ({ tree: state.tree, legacy: state.legacy }) },
};

/**
 * Each agent's tree, and the one the terminal shows: the top-level session
 * opened or changed last. dsh-tui tells plugins which session it shows only
 * through its gated decision events, and only the session it shows runs turns,
 * so the newest top-level activity stands for it; subagent sessions never do.
 */
export class TreeDisplay {
  /** What each session's log last recorded its tree as. */
  readonly #recorded = new Map<string, string>();
  /** Each session's current tree, with its signature. */
  readonly #trees = new Map<string, { tree: SpineTree; signature: string }>();
  /** Top-level sessions, the most recently opened or changed last. */
  #recent: string[] = [];
  readonly #listeners = new Set<() => void>();

  /** Follow an agent's session from the last tree its log recorded. */
  open(session: Session): void {
    const events = session.snapshotEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const record = pluginRecordOf(events[index]!);
      if (record?.type !== TREE_RECORD) continue;
      const tree = treeSchema.safeParse(record.data);
      if (!tree.success) continue;
      const signature = JSON.stringify(tree.data);
      this.#recorded.set(session.id, signature);
      this.#trees.set(session.id, { tree: tree.data, signature });
      break;
    }
    this.#touch(session);
  }

  /** The agent published or committed a projection: when what its tree shows changed, show it and record it. */
  update(session: Session, projection: SpineProjection): void {
    const tree = spineTreeOf(projection);
    const signature = JSON.stringify(tree);
    if (this.#trees.get(session.id)?.signature !== signature) {
      this.#trees.set(session.id, { tree, signature });
      this.#touch(session);
    }
    if (this.#recorded.get(session.id) === signature) return;
    appendPluginRecord(session, TREE_RECORD, tree);
    this.#recorded.set(session.id, signature);
  }

  close(id: string): void {
    const shown = this.#shownId();
    this.#recorded.delete(id);
    this.#trees.delete(id);
    this.#recent = this.#recent.filter((other) => other !== id);
    if (shown === id) this.#emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The shown session's tree: the same object until it changes, as useSyncExternalStore needs. */
  readonly shown = (): SpineTree | null => {
    const id = this.#shownId();
    return id === null ? null : this.#trees.get(id)?.tree ?? null;
  };

  #shownId(): string | null {
    return this.#recent.at(-1) ?? null;
  }

  /** A top-level session became active: it is the one shown. */
  #touch(session: Session): void {
    const shown = this.#shownId();
    if (session.header.origin === "subagent") {
      if (shown === session.id) this.#emit();
      return;
    }
    this.#recent = [...this.#recent.filter((other) => other !== session.id), session.id];
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
