import type { NodeSnapshot } from "@spinejit/spine-sdk";

export { queryPiSpineMode, SPINETREE_MODE_QUERY, type PiSpineMode } from "./session-mode.js";

/** Public Pi event channel. Requests and offers are synchronous within emit(). */
export const SPINE_TREE_VIEW_REQUEST = "spinejit:tree-view:v1";

export interface SpineTreeSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly nodes: readonly NodeSnapshot[];
  readonly cursor: readonly number[];
}

export type SpineTreeViewEnd = "released" | "invalidated" | "render-error";

/** A bounded display contribution; input remains owned by Pi custom(). */
export interface SpineTreeView {
  render(width: number, maxHeight: number): string[];
  invalidate(): void;
}

export interface SpineTreeViewLease {
  redraw(): void;
  release(): void;
}

export interface SpineTreeViewConnection {
  readonly version: 1;
  readonly snapshot: SpineTreeSnapshot;
  /** Throws if unavailable, already occupied, or this connection is stale. */
  attach(view: SpineTreeView, onEnd: (reason: SpineTreeViewEnd) => void): SpineTreeViewLease;
}

export interface SpineTreeViewRequest {
  readonly version: 1;
  readonly sessionId: string;
  accept(connection: SpineTreeViewConnection): void;
}
