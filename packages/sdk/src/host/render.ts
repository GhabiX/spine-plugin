import type { SpawnArrival, SpawnTask } from "../index.js";

// The model-visible text of Spine context items. Every host renders the same
// text, so a plan reads the same to the model whichever harness carries it.

/** A node descriptor. Live and opened nodes carry the configured node prompt. */
export function spineNodeText(
  nodeId: readonly number[],
  summary: string,
  status: "Live" | "Opened" | "Closed" | "Compacted",
  nodePrompt: string,
): string {
  const prompt = status === "Live" || status === "Opened" ? nodePrompt.trim() : "";
  const inner = prompt.length > 0 ? `\n${prompt}\n` : "\n";
  return `<spine_node id="${nodeId.join(".")}" summary="${escapeXmlAttribute(summary)}" status="${status.toLowerCase()}">${inner}</spine_node>`;
}

/** The memory a closed node returns to its parent. */
export function spineMemoryText(owner: readonly number[], body: string): string {
  return `<spine_memory node_id="${owner.join(".")}">\n${body}\n</spine_memory>`;
}

/** The birth record of a spawned branch. */
export function spineBirthText(owner: readonly number[], task: SpawnTask): string {
  return `<spine_spawn node_id="${owner.join(".")}" summary="${escapeXmlAttribute(task.summary)}">\n${task.prompt}\n</spine_spawn>`;
}

/** A spawned branch's terminal result as its parent receives it. */
export function spineArrivalText(arrival: SpawnArrival): string {
  const body = arrival.outcome === "completed" ? arrival.memory! : arrival.diagnostic!;
  return `<spine_arrival node_id="${arrival.producer.join(".")}" outcome="${arrival.outcome}">\n${body}\n</spine_arrival>`;
}

/** The tool a Spawn child calls once to return its memory to its parent. */
export const SPINE_CHILD_RETURN_TOOL = "spine_child_return";

/** FormularDef 2.5 Δ_child: a Spawn child's assignment: identity, peers, inherited-scope rules, and typed return. */
export function spineChildAssignmentText(task: SpawnTask, peers: readonly SpawnTask[]): string {
  const identity = task.summary.trim();
  const peerLines = peers
    .map((peer) => peer.summary.trim())
    .filter((summary) => summary !== identity)
    .map((summary) => `- ${summary}`);
  const peersBlock = peerLines.length === 0 ? "- (none)" : peerLines.join("\n");
  return `You are a spawned execution branch. Your role is to complete exactly the assignment below and return bounded terminal memory to the spawning continuation.

You are: ${identity}

Peer branches in this spawn:
${peersBlock}

The assignment is already an active branch scope. Begin the assigned work directly. Use spine_open, spine_close, and spine_next only to manage genuine descendant work within this assignment. Use spine_spawn only when this assignment itself has two or more independent parallel sub-assignments.

Executable work is defined by the assignment. Inherited context supplies constraints and evidence for that work.

When the assignment declares a collaboration contract, follow its named root, peer roles, artifact format, update/read protocol, synchronization points, and bounded fallback. Inspect the coordination root before substantive work. Coordinate through it to minimize unnecessary duplicate work: respect assigned scopes, share reusable evidence early, and independently verify load-bearing or disputed claims. Within the coordination root, write only your declared single-writer artifact and read peer artifacts through the declared protocol, even when the investigated source and evidence are otherwise read-only. Unless the contract provides locking or atomic append, preserve your artifact append-only. Publish findings, conflicts, or requests useful to peers at the declared synchronization points. Before returning your final memory, perform the declared final peer read and state which peer deltas you incorporated. Never write a peer artifact, let collaboration expand the assignment, make completion depend on peer state, or treat collaboration artifacts as correctness-critical evidence. If the root or peer state is unavailable or incomplete, use the declared bounded fallback; do not invent another coordination path.

Other shared-workspace changes remain context for the assignment and do not add executable work. Production-file ownership and any integration responsibility remain exactly as declared in the assignment.

Complete this branch by calling ${SPINE_CHILD_RETURN_TOOL} exactly once with the complete continuation memory. After that call, execution ends.

Assignment:
${task.prompt}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
