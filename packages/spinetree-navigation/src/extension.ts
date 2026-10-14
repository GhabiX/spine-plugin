import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SPINE_TREE_VIEW_REQUEST,
  queryPiSpineMode,
  type PiSpineMode,
  type SpineTreeViewConnection,
  type SpineTreeViewLease,
  type SpineTreeViewRequest,
} from "@spinejit/pi-spinejit/pi/tree-view";

import { SpineTreeBrowser } from "./browser.js";
import { createNavigationData } from "./data.js";

/** Optional companion: no tools, runtime, context hooks, or widget ownership. */
export default function spineTreeNavigation(pi: ExtensionAPI): void {
  let active = false;
  const modes = new Map<string, PiSpineMode>();
  let mode: PiSpineMode = "sdk";
  pi.on("session_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    mode = modes.get(id) ?? queryPiSpineMode(pi, ctx);
    modes.set(id, mode);
  });
  pi.registerCommand("spine-tree", {
    description: "Navigate the bottom Spine tree and read memory",
    handler: async (args, ctx) => {
      if (mode === "st") {
        if (ctx.hasUI) ctx.ui.notify("This session uses SpineTree; use /st or shell st branch/show/context.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Spine tree navigation requires Pi interactive mode.", "info");
        return;
      }
      if (active) {
        ctx.ui.notify("Spine tree navigation is already open.", "info");
        return;
      }
      let lease: SpineTreeViewLease | undefined;
      active = true;
      try {
        const offers: SpineTreeViewConnection[] = [];
        const sessionId = ctx.sessionManager.getSessionId();
        const request: SpineTreeViewRequest = {
          version: 1,
          sessionId,
          accept(connection) { offers.push(connection); },
        };
        pi.events.emit(SPINE_TREE_VIEW_REQUEST, request);
        if (offers.length !== 1) {
          ctx.ui.notify(offers.length === 0
            ? "SpineJIT with tree navigation support is required and must have an active session."
            : "Multiple SpineJIT instances offered the tree. Enable only one core plugin.", "warning");
          return;
        }
        const connection = offers[0]!;
        if (connection.version !== 1 || connection.snapshot.sessionId !== sessionId) {
          ctx.ui.notify("SpineJIT tree connection is incompatible with this session.", "warning");
          return;
        }
        const data = createNavigationData(connection.snapshot);
        const nodeId = args.trim();
        const initialNodeId = nodeId && data.nodes.some(node => node.id === nodeId) ? nodeId : undefined;
        if (nodeId && !initialNodeId) ctx.ui.notify(`Spine node ${nodeId} is unavailable; showing the current node.`, "warning");
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          let ended = false;
          const finish = () => {
            if (ended) return;
            ended = true;
            done();
          };
          const browser = new SpineTreeBrowser({
            data,
            ...(initialNodeId ? { initialNodeId } : {}),
            theme,
            markdownTheme: getMarkdownTheme(),
            keybindings,
            redraw() { lease?.redraw(); tui.requestRender(); },
            close: finish,
          });
          lease = connection.attach(browser, reason => {
            finish();
            if (reason === "render-error") ctx.ui.notify("Spine navigation display failed; the default tree was restored.", "error");
          });
          return {
            render: width => browser.renderControls(width),
            invalidate: () => browser.invalidate(),
            handleInput(input) {
              if (ended) return;
              try { browser.handleInput(input); }
              catch (cause) {
                finish();
                ctx.ui.notify(`Spine navigation failed: ${errorMessage(cause)}`, "error");
              }
            },
            dispose() { lease?.release(); },
          };
        });
      } catch (cause) {
        ctx.ui.notify(`Spine navigation unavailable: ${errorMessage(cause)}`, "error");
      } finally {
        lease?.release();
        active = false;
      }
    },
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
