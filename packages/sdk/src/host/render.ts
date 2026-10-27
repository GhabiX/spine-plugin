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

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
