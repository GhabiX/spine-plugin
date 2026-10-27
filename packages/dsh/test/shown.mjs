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

export const node = (id, summary) => `spine: <spine_node id="${id}" summary="${summary}" status="opened">\n</spine_node>`;
export const memory = (id, body) => `spine: <spine_memory node_id="${id}">\n${body}\n</spine_memory>`;
export const call = (name, input) => `assistant: ${name} ${JSON.stringify(input)}`;
export const staged = (name) => `tool: Spine ${name} staged`;
