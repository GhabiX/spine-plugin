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
import SubagentRuntime from "@deepseek-ai/dsh-subagent";

const PLUGIN = new URL("../dist/index.js", import.meta.url).href;

/** Answers each request with the next scripted reply; records every request. */
export class ScriptedAdapter extends LlmAdapter {
  requests = [];
  #replies;

  /**
   * @param replies one per request, or an object of such lists by session id
   *   when several sessions run: a string is text, an array is tool calls
   *   `[name, input]`, `{ text, finish }` is text that ends with that finish
   *   kind (null: the stream ends without a finish chunk), `{ fail }` throws that message, `{ hang: true }` waits for the
   *   request to be aborted, and a function of the request returns the reply.
   */
  constructor(replies) {
    super();
    this.#replies = Array.isArray(replies)
      ? [...replies]
      : Object.fromEntries(Object.entries(replies).map(([id, list]) => [id, [...list]]));
  }

  async *stream(request) {
    this.requests.push(request);
    const queue = Array.isArray(this.#replies) ? this.#replies : this.#replies[request.sessionId] ?? [];
    let reply = queue.shift();
    if (typeof reply === "function") reply = await reply(request);
    if (reply === undefined) throw new Error(`no scripted reply for request ${this.requests.length} of ${request.sessionId}`);
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
    if (reply.finish === null) return;
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
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(Jsonl, { root: join(root, "sessions"), compression: "none" });
  await ctx.plugin(SubagentRuntime);
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
    /** Run one task as `dsh --profile headless` does: until the agent and every subagent it waits on are done. */
    async runHeadless(text) {
      const agent = await harness.create(`session-${++sessions}`, { provider: "scripted", model: "scripted" }, { cwd: root });
      this.agent = agent;
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      while (true) {
        await agent.whenIdle();
        const idleSeq = agent.session.seq;
        if (!await ctx.subagents.waitForChildren(agent) && agent.status === "idle" && agent.session.seq === idleSeq) break;
      }
      return agent;
    },
    async send(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      await agent.whenIdle();
    },
    /** The model context DSH restores from the official JSONL log, without any plugin; a session id names a disposed one. */
    async restored(agent) {
      if (typeof agent !== "string") await ctx.sessions.flush(agent.session);
      const id = typeof agent === "string" ? agent : agent.id;
      const handle = await ctx.sessionPersistence.open(id, "read");
      try {
        const data = await handle.read();
        return Session.fromRestore(id, data.events, handle.header, handle.inheritedEventCount, data.eventState)
          .deriveMessages();
      } finally {
        await handle.close();
      }
    },
    /** Every event a session published, in log order, by agent or session id. */
    events: (agent) => events.get(typeof agent === "string" ? agent : agent.id) ?? [],
    dispose: () => ctx.fiber.dispose(),
  };
}
