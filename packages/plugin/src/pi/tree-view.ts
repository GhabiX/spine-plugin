import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpineProjection } from "@spinejit/spine-sdk";

import {
  displayTreeSignature,
  formatThemedPrettySpineTree,
  prettySpineTreeHasTasks,
  type SpineTheme,
} from "@spinejit/spine-sdk/view";
import type {
  SpineTreeView,
  SpineTreeViewEnd,
  SpineTreeViewRequest,
} from "./tree-view-contract.js";
import { clampLines } from "./tui-width.js";

const WIDGET_KEY = "spine-tree";
/** Where the widget's compacted row points: `/spine-tree` browses every epoch, the compacted ones too. */
const COMPACTED_HINT = "/spine-tree to look back";

type Contribution = {
  view: SpineTreeView;
  onEnd: (reason: SpineTreeViewEnd) => void;
};

type DisplaySession = {
  ctx: ExtensionContext;
  sessionId: string;
  generation: number;
  projection: SpineProjection;
  signature: string;
  contribution: Contribution | null;
  requestRender: () => void;
};

/** Owns one Pi widget. All callbacks into optional views stop at this UI boundary. */
export class SpineTreeDisplay {
  private current: DisplaySession | null = null;

  publish(ctx: ExtensionContext, generation: number, projection: SpineProjection): void {
    if (ctx.mode !== "tui") return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      let current = this.current;
      if (current === null || current.generation !== generation || current.sessionId !== sessionId) {
        this.reset();
        current = {
          ctx, sessionId, generation, projection,
          signature: displayTreeSignature(projection),
          contribution: null,
          requestRender() {},
        };
        this.current = current;
        const installed = current;
        try {
          ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
            installed.requestRender = () => tui.requestRender();
            return {
              render: (width) => this.render(installed, theme, width, Math.max(1, tui.terminal.rows - 6)),
              invalidate: () => this.invalidate(installed),
              dispose: () => this.disposed(installed),
            };
          }, { placement: "aboveEditor" });
        } catch (error) {
          // A failed registration must not offer an invisible browsing surface.
          if (this.current === installed) this.current = null;
          throw error;
        }
        return;
      }
      // Always retain the newest projection, including memory-only changes.
      current.projection = projection;
      const signature = displayTreeSignature(projection);
      if (signature !== current.signature) {
        current.signature = signature;
        if (current.contribution === null) this.redraw(current);
      }
    } catch (error) {
      this.report(ctx, error);
    }
  }

  /** Caller supplies the latest published projection, not a cached drawing signature. */
  offer(request: unknown, generation: number, projection: SpineProjection): void {
    const current = this.current;
    if (current === null || current.generation !== generation || !isRequest(request)
      || request.sessionId !== current.sessionId) return;
    try {
      current.projection = projection;
      const snapshot = structuredClone({
        sessionId: current.sessionId,
        generation,
        nodes: projection.nodes,
        cursor: projection.cursor,
      });
      request.accept({
        version: 1,
        snapshot,
        attach: (view, onEnd) => {
          if (this.current !== current) throw new Error("Spine tree connection is no longer active");
          if (current.contribution !== null) throw new Error("Spine tree is already being browsed");
          const contribution = { view, onEnd };
          current.contribution = contribution;
          this.redraw(current);
          return {
            redraw: () => {
              if (this.current === current && current.contribution === contribution) this.redraw(current);
            },
            release: () => {
              if (this.current !== current || current.contribution !== contribution) return;
              this.end(current, "released");
              this.redraw(current);
            },
          };
        },
      });
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  reset(): void {
    const current = this.current;
    if (current === null) return;
    this.current = null;
    this.end(current, "invalidated");
    try {
      current.ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private disposed(current: DisplaySession): void {
    if (this.current !== current) return;
    this.current = null;
    // Pi may dispose this widget before session_shutdown (notably on reload).
    // Notify now; never recursively remove the widget being disposed by Pi.
    this.end(current, "invalidated");
  }

  private render(current: DisplaySession, theme: SpineTheme, width: number, height: number): string[] {
    if (this.current !== current) return [];
    if (current.contribution !== null) {
      try {
        return clampLines(current.contribution.view.render(width, height).slice(0, height), width);
      } catch (error) {
        this.report(current.ctx, error);
        this.end(current, "render-error");
      }
    }
    try {
      return prettySpineTreeHasTasks(current.projection)
        ? clampLines([...formatThemedPrettySpineTree(current.projection, theme, { compactedHint: COMPACTED_HINT }), ""]
          .slice(0, height), width)
        : [];
    } catch (error) {
      this.report(current.ctx, error);
      return [];
    }
  }

  private invalidate(current: DisplaySession): void {
    if (this.current !== current || current.contribution === null) return;
    try {
      current.contribution.view.invalidate();
    } catch (error) {
      this.report(current.ctx, error);
      this.end(current, "render-error");
    }
  }

  private end(current: DisplaySession, reason: SpineTreeViewEnd): void {
    const contribution = current.contribution;
    current.contribution = null;
    if (contribution === null) return;
    try {
      contribution.onEnd(reason);
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private redraw(current: DisplaySession): void {
    try {
      current.requestRender();
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private report(ctx: ExtensionContext, error: unknown): void {
    try {
      ctx.ui.notify(`Spine tree display: ${error instanceof Error ? error.message : String(error)}`, "error");
    } catch {
      // UI failure must not escape into sampling/compaction error handling.
    }
  }
}

function isRequest(value: unknown): value is SpineTreeViewRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<SpineTreeViewRequest>;
  return request.version === 1 && typeof request.sessionId === "string" && typeof request.accept === "function";
}
