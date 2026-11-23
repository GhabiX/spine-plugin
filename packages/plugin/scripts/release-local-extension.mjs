// Synthetic unrelated local extension. Copied as agent/extensions/*.js so the
// real host auto-discovers it alongside the manifest-discovered Spine package.
// Never loads the user's actual extensions, settings or credentials.
import { appendFileSync } from "node:fs";

export default function releaseLocalExtension(pi) {
  const record = (event, ctx) => appendFileSync(process.env.SPINE_RELEASE_NEIGHBOR_LOG,
    `${JSON.stringify({ event, sessionId: ctx.sessionManager.getSessionId() })}\n`);
  for (const event of ["session_start", "session_shutdown", "before_agent_start", "context", "turn_end", "agent_settled"]) {
    pi.on(event, (value, ctx) => {
      record(event, ctx);
      // Participate in context chaining without replacing another extension's work.
      if (event === "context") return { messages: value.messages };
    });
  }
  pi.registerTool({
    name: "release_neighbor_ping", label: "Release neighbor ping",
    description: "Deterministic unrelated local-extension coexistence fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _update, ctx) {
      record("execute", ctx);
      return { content: [{ type: "text", text: "RELEASE_NEIGHBOR_OK" }], details: { fixture: true } };
    },
  });
  pi.registerCommand("release-neighbor", {
    description: "Release gate: unrelated extension command",
    handler: async (_args, ctx) => {
      pi.appendEntry("release.neighbor.v1", { fixture: true });
      ctx.ui.notify("RELEASE_NEIGHBOR_COMMAND_OK", "info");
    },
  });
}
