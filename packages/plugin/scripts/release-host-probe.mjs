// Test-only observer, loaded separately by the real Pi CLI. Never imports or
// invokes the plugin factory: settings package discovery must load that itself.
import { appendFileSync } from "node:fs";

export default function releaseHostProbe(pi) {
  const record = (value) => appendFileSync(process.env.SPINE_RELEASE_PROBE_LOG, `${JSON.stringify(value)}\n`);
  for (const name of ["session_start", "session_shutdown", "before_agent_start", "context", "tool_call", "tool_result", "turn_end", "agent_settled"]) {
    pi.on(name, (event, ctx) => {
      record({ event: name, reason: event.reason, sessionId: ctx.sessionManager.getSessionId(),
        toolName: event.toolName, stopReason: event.message?.stopReason });
    });
  }
  pi.registerCommand("spine-release-inspect", {
    description: "Release gate: inspect the host's actual registered tools and durable branch",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`SPINE_RELEASE_PROBE:${JSON.stringify({
        sessionId: ctx.sessionManager.getSessionId(),
        tools: pi.getAllTools().filter(tool => tool.name.startsWith("spine_")).map(tool => ({
          name: tool.name, description: tool.description, parameters: tool.parameters,
          sourceInfo: tool.sourceInfo,
        })),
        neighborTools: pi.getAllTools().filter(tool => tool.name === "release_neighbor_ping"),
        neighborEntries: ctx.sessionManager.getBranch().filter(entry => entry.customType === "release.neighbor.v1"),
        archives: ctx.sessionManager.getBranch().filter(entry => entry.customType?.startsWith("spine.")),
      })}`, "info");
    },
  });
  pi.registerCommand("spine-release-quit", {
    description: "Release gate: orderly RPC shutdown",
    handler: async (_args, ctx) => { ctx.shutdown(); },
  });
}
