// How tests write down what a request shows the model.

/** What one request shows the model, minus the system prompt; Spine items marked. */
export function shown(request) {
  return request.messages.flatMap((message) => {
    if (message.role === "system") return [];
    const text = message.content.map((block) =>
      block.type === "text" ? block.text : block.type === "tool-call" ? `${block.name} ${block.arguments}` : `<${block.type}>`).join("");
    const kind = message.source.kind;
    const role = kind === "spine" ? "spine" : kind === "runtime-context" ? "context" : message.role;
    return [`${role}: ${role === "context" ? "…" : text}`];
  });
}

export const closed = (id, summary) => `spine: <spine_node id="${id}" summary="${summary}" status="closed">\n</spine_node>`;
export const memory = (id, body) => `spine: <spine_memory node_id="${id}">\n${body}\n</spine_memory>`;
export const call = (name, input) => `assistant: ${name} ${JSON.stringify(input)}`;
const descriptor = (id, summary) => `<spine_node id="${id}" summary="${summary}" status="opened">\n</spine_node>`;
/**
 * A Spine call's result. Open names the node it opened (id, summary); Close
 * the node it closed; Next the node it closed, then the one it opened; Spawn
 * its task count.
 */
export const result = (name, ...args) => {
  if (name === "spine_open") return `tool: The node is open.\n\n${descriptor(args[0], args[1])}`;
  if (name === "spine_spawn") return `tool: Spine Spawn accepted ${args[0]} tasks. Each child starts when this turn ends, and its result arrives later as its own message. This node cannot close until all of them have arrived.`;
  const [arg = "1.1", id, summary] = args;
  const closed = `Node ${arg} is closed and its memory is recorded.`;
  if (name === "spine_next") return `tool: ${closed} The next node is open.\n\n${descriptor(id, summary)}`;
  const parent = arg.split(".").slice(0, -1);
  return `tool: ${closed} ${parent.length === 1 ? "You are back at the root." : `You are back in node ${parent.join(".")}.`}`;
};
export const arrival = (id, outcome, body) => `user: <spine_arrival node_id="${id}" outcome="${outcome}">\n${body}\n</spine_arrival>`;
