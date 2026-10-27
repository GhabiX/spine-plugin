// A real DeepSeek Harness world for tests: the production AgentLoop, session
// store and official JSONL persistence, with a scripted model adapter.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { createUserMessage, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";

const PLUGIN = new URL("../dist/index.js", import.meta.url).href;

/** Answers each request with the next scripted reply; records every request. */
export class ScriptedAdapter extends LlmAdapter {
  requests = [];
  #replies;

  /** @param replies one per request: a string is text, an array is tool calls `[name, input]`. */
  constructor(replies) {
    super();
    this.#replies = [...replies];
  }

  async *stream(request) {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error(`no scripted reply for request ${this.requests.length}`);
    const blocks = typeof reply === "string"
      ? [{ type: "text", text: reply }]
      : reply.map(([name, input], index) => ({
        type: "tool-call",
        id: `call-${this.requests.length}-${index}`,
        name,
        arguments: JSON.stringify(input),
      }));
    for (const [index, block] of blocks.entries()) {
      yield { type: "block-start", index, blockType: block.type };
      yield { type: "block-end", index, block };
    }
    yield { type: "finish", reason: { kind: typeof reply === "string" ? "stop" : "tool-calls" } };
  }
}

/**
 * Mount DSH with the plugin loaded by the Cordis Loader, as a bundle loads it.
 * @param replies the scripted model replies.
 * @param plugin false to run the same world without the plugin.
 */
export async function mountDsh(replies, { plugin = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-spinejit-"));
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(Jsonl, { root: join(root, "sessions"), compression: "none" });
  await ctx.plugin(Loader);
  if (plugin) {
    await ctx.loader.root.update([{ id: "spinejit", name: PLUGIN }]);
    await ctx.loader.await();
  }
  const harness = await mountAgentLoopTestHarness(ctx);
  const adapter = new ScriptedAdapter(replies);
  ctx.llm.registerAdapter(["scripted"], adapter);
  let sessions = 0;
  return {
    ctx,
    adapter,
    /** Create an agent and run one user message until the loop is idle. */
    async run(text) {
      const agent = await harness.create(`session-${++sessions}`, { provider: "scripted", model: "scripted" }, { cwd: root });
      await this.send(agent, text);
      return agent;
    },
    async send(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      await agent.whenIdle();
    },
    /** The model context DSH restores from the official JSONL log, without any plugin. */
    async restored(agent) {
      await ctx.sessions.flush(agent.session);
      const handle = await ctx.sessionPersistence.open(agent.id, "read");
      try {
        const data = await handle.read();
        return Session.fromRestore(agent.id, data.events, handle.header, handle.inheritedEventCount, data.eventState)
          .deriveMessages();
      } finally {
        await handle.close();
      }
    },
    dispose: () => ctx.fiber.dispose(),
  };
}
