import type { MemorySlot, NodeSnapshot } from "@spinejit/spine-sdk";
import type { SpineTreeSnapshot } from "@spinejit/pi-spinejit/pi/tree-view";
import { spineTreeSpawnOutcome, type SpineTreeSpawnState } from "@spinejit/pi-spinejit/pi/tree-style";

export interface NavigationNode {
  id: string;
  parent: string | null;
  children: string[];
  summary: string;
  status: NodeSnapshot["status"];
  kind: NodeSnapshot["kind"];
  spawn: SpineTreeSpawnState | null;
}
export interface NavigationData {
  nodes: readonly NavigationNode[];
  cursor: string;
  memorySections(nodeId: string, full?: boolean): readonly string[];
  memoryText(nodeId: string, full?: boolean): string;
}

const id = (parts: readonly number[]): string => parts.join(".");

/** Read-only node and memory view of one published Spine snapshot. */
export function createNavigationData(snapshot: SpineTreeSnapshot): NavigationData {
  const rawNodes = new Map(snapshot.nodes.map(node => [id(node.id), node]));
  const nodes = snapshot.nodes.map(node => ({
    id: id(node.id), parent: node.parent === null ? null : id(node.parent),
    children: node.children.map(id), summary: node.summary ?? (node.kind === "RootEpoch" ? "Session epoch" : "Task"),
    status: node.status, kind: node.kind,
    spawn: node.spawn,
  }));
  return {
    nodes, cursor: id(snapshot.cursor),
    memorySections(nodeId, full = false) {
      const node = rawNodes.get(nodeId);
      if (node === undefined) return ["Node is unavailable in this snapshot."];
      const slots = node.memory ?? [];
      if (full) return slots.length === 0 ? [noMemory(node)] : slots.map(slot => slotText(slot, rawNodes));
      if (node.kind === "Spawn") return slots.map(slot => slotText(slot, rawNodes));
      const own = slots.flatMap(slot => "Summary" in slot && id(slot.Summary.owner_node) === nodeId ? [slot.Summary.body] : []);
      // Keep each owned summary as its own section so the browser can render
      // only the section currently in view, even when a node has multiple summaries.
      return own.length === 0 ? [noMemory(node)] : own;
    },
    memoryText(nodeId, full = false) {
      return this.memorySections(nodeId, full).join("\n\n---\n\n");
    },
  };
}

function noMemory(node: NodeSnapshot): string {
  return `No final memory for this node (${node.status}).`;
}
function slotText(slot: MemorySlot, nodes: ReadonlyMap<string, NodeSnapshot>): string {
  if ("Summary" in slot) {
    const s = slot.Summary;
    return `### Memory · ${id(s.owner_node)} · source ${s.source.start}–${s.source.end}\n\n${s.body}`;
  }
  if ("User" in slot) {
    const u = slot.User;
    return `### User evidence · ${id(u.owner_node)} · anchor ${u.anchor}\n\nRole: ${u.message.role}; boundary: ${u.message.boundary}\n\n${u.message.content}`;
  }
  if ("Birth" in slot) {
    const b = slot.Birth;
    const spawn = nodes.get(id(b.owner_node))?.spawn ?? null;
    const outcome = spawn === "inherited" ? "inherited" : spineTreeSpawnOutcome(spawn) ?? "running";
    return `### Spawn · ${id(b.owner_node)} · ${outcome}\n\n${b.task.summary}\n\n${b.task.prompt}`;
  }
  if ("Arrival" in slot) {
    const a = slot.Arrival.arrival;
    const body = a.outcome === "completed" ? a.memory : `Diagnostic: ${a.diagnostic}`;
    return `### Arrival · ${id(a.producer)} · ${a.outcome} · received in ${id(slot.Arrival.owner_node)}\n\n${body}`;
  }
  const r = slot.Reply;
  return `### Reply · ${id(r.owner_node)}\n\n${r.message.content}`;
}
