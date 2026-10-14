import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Discovery belongs to SpineTree L1, never to the SDK plugin. */
export const SPINETREE_MODE_QUERY = "spinetree:mode";
export type PiSpineMode = "st" | "sdk";

export function queryPiSpineMode(pi: ExtensionAPI, ctx: ExtensionContext): PiSpineMode {
  const query: { cwd: string; sessionId: string; mode?: PiSpineMode } = {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
  };
  // Pi's bus invokes synchronous responders before emit returns. No L1 => SDK.
  pi.events.emit(SPINETREE_MODE_QUERY, query);
  return query.mode ?? "sdk";
}
