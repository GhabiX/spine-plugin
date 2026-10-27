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

  /**
   * @param replies one per request: a string is text, an array is tool calls
   *   `[name, input]`, `{ text, finish }` is text that ends with that finish
   *   kind, `{ fail }` throws that message, `{ hang: true }` waits for the
   *   request to be aborted, and a function of the request returns the reply.
   */
  constructor(replies) {
    super();
    this.#replies = [...replies];
  }

  async *stream(request) {
    this.requests.push(request);
    let reply = this.#replies.shift();
    if (typeof reply === "function") reply = await reply(request);
    if (reply === undefined) throw new Error(`no scripted reply for request ${this.requests.length}`);
    if (reply.fail !== undefined) throw new Error(reply.fail);
    if (reply.hang === true) {
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      throw request.signal.reason;
    }
    const text = typeof reply === "string" ? reply : reply.text;
    const blocks = text !== undefined
      ? [{ type: "text", text }]
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
    yield { type: "finish", reason: { kind: reply.finish ?? (text !== undefined ? "stop" : "tool-calls") } };
  }
}

/**
 * Mount DSH with the plugin loaded by the Cordis Loader, as a bundle loads it.
 * @param replies the scripted model replies.
 * @param plugin false to run the same world without the plugin.
 * @param root an earlier world's directory, to resume its persisted sessions.
 */
export async function mountDsh(replies, { plugin = true, root } = {}) {
  root ??= await mkdtemp(join(tmpdir(), "dsh-spinejit-"));
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(Jsonl, { root: join(root, "sessions"), compression: "none" });
  await ctx.plugin(Loader);
  if (plugin) {
    await ctx.loader.root.update([{ id: "spinejit", name: PLUGIN }]);
    await ctx.loader.await();
  }
  const events = new Map();
  ctx.on("session/event", (session, event) => {
    if (!events.has(session.id)) events.set(session.id, []);
    events.get(session.id).push(event);
  });
  const harness = await mountAgentLoopTestHarness(ctx);
  const adapter = new ScriptedAdapter(replies);
  ctx.llm.registerAdapter(["scripted"], adapter);
  let sessions = 0;
  return {
    ctx,
    adapter,
    root,
    /** Create an agent and run one user message until the loop is idle. */
    async run(text) {
      const agent = await harness.create(`session-${++sessions}`, { provider: "scripted", model: "scripted" }, { cwd: root });
      this.agent = agent;
      await this.send(agent, text);
      return agent;
    },
    /** Resume a persisted session, as a restarted process does. */
    async resume(id) {
      const { agent } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: "scripted", model: "scripted" } });
      this.agent = agent;
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
    /** Every event the agent's session published, in log order. */
    events: (agent) => events.get(agent.id) ?? [],
    dispose: () => ctx.fiber.dispose(),
  };
}
