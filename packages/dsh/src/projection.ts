import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import type { ContextPlanCell, EpochOrdinalId } from "@spinejit/spine-sdk";
import {
  spineBirthText,
  spineMemoryText,
  spineNodeText,
  type PublishedContext,
} from "@spinejit/spine-sdk/host";

import { emptySlot, SpineDshError, spineMessage, type SurfaceRole } from "./events.js";

// The model context is the DSH session surface. A Spine plan becomes surface
// edits by one pure rule, so the same (surface, plan) always yields the same
// edits and a restart recomputes them instead of storing them.

/** One model-visible item of a Spine plan in DSH terms. */
export type PlanItem =
  /** A logged source event shown as it is; `anchor` is its `[U<n>]`, if any. */
  | { type: "source"; seq: SessionSeq; anchor: number | null }
  /** Text this plugin writes as a user message. */
  | { type: "spine"; text: string };

/** One surface node as the projection sees it. `text` is a spine node's visible text. */
export interface SurfaceNode {
  seq: SessionSeq;
  role: SurfaceRole;
  text: string | null;
}

export type SurfaceEdit =
  | { type: "replace"; startSeq: SessionSeq; endSeq: SessionSeq; shadowed: SessionSeq[]; text: string | null }
  | { type: "append"; text: string };

/** The plan's items. A reply stays its original assistant event. */
export function planItems(
  context: PublishedContext,
  seqOf: (id: EpochOrdinalId) => SessionSeq,
  nodePrompt: string,
): PlanItem[] {
  const plan = context.contextPlan;
  if (plan === null) throw new SpineDshError("Spine published no context plan");
  return plan.cells.map((cell) => planItem(cell, seqOf, nodePrompt));
}

function planItem(
  cell: ContextPlanCell,
  seqOf: (id: EpochOrdinalId) => SessionSeq,
  nodePrompt: string,
): PlanItem {
  if (cell.type === "source") {
    const anchors = cell.labels.flatMap((label) => (label === "Reply" ? [] : [label.UserAnchor]));
    if (anchors.length > 1) throw new SpineDshError(`source ${seqOf(cell.source_id)} has ${anchors.length} user anchors`);
    return { type: "source", seq: seqOf(cell.source_id), anchor: anchors[0] ?? null };
  }
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const { node_id: nodeId, summary, status } = item.SyntheticNode;
    return { type: "spine", text: spineNodeText(nodeId, summary, status, nodePrompt) };
  }
  if ("MemorySlot" in item) {
    const slot = item.MemorySlot;
    if ("Summary" in slot) return { type: "spine", text: spineMemoryText(slot.Summary.owner_node, slot.Summary.body) };
    if ("Birth" in slot) return { type: "spine", text: spineBirthText(slot.Birth.owner_node, slot.Birth.task) };
  }
  throw new SpineDshError(`DSH cannot show Spine plan item ${JSON.stringify(item).slice(0, 80)}`);
}

/**
 * The surface edits that make the surface show the plan.
 *
 * The plan's sources are anchors: they must appear on the surface in plan
 * order. Between two anchors, the surface is split at host nodes into runs;
 * the plan's spine items between those anchors belong to the last run and
 * every other run must show nothing. A run already showing its items is left
 * alone. Otherwise a run with no items becomes one empty slot, and a run with
 * k items gives its last k-1 nodes one item each and the first item the rest.
 * Items after the last anchor with no run to hold them are appended.
 */
export function surfaceEdits(surface: readonly SurfaceNode[], plan: readonly PlanItem[]): SurfaceEdit[] {
  const cuts: number[] = [];
  const groups: string[][] = [[]];
  let at = 0;
  for (const item of plan) {
    if (item.type === "spine") {
      groups.at(-1)!.push(item.text);
      continue;
    }
    while (at < surface.length && surface[at]!.seq !== item.seq) at += 1;
    if (at === surface.length || surface[at]!.role !== "source") {
      throw new SpineDshError(`Spine plan source ${item.seq} is not on the session surface in plan order`);
    }
    cuts.push(at);
    groups.push([]);
    at += 1;
  }
  return groups.flatMap((texts, index) => {
    const from = index === 0 ? 0 : cuts[index - 1]! + 1;
    const to = index < cuts.length ? cuts[index]! : surface.length;
    return segmentEdits(surface.slice(from, to), texts, index === cuts.length);
  });
}

function segmentEdits(nodes: readonly SurfaceNode[], texts: readonly string[], last: boolean): SurfaceEdit[] {
  const runs: SurfaceNode[][] = [];
  let run: SurfaceNode[] = [];
  for (const node of nodes) {
    if (node.role !== "host") {
      run.push(node);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  if (runs.length === 0) {
    if (texts.length === 0) return [];
    if (last) return texts.map((text) => ({ type: "append", text }));
    throw new SpineDshError(`${texts.length} Spine items have no surface nodes to occupy`);
  }
  return runs.flatMap((nodes, index) => runEdits(nodes, index === runs.length - 1 ? texts : []));
}

function runEdits(run: readonly SurfaceNode[], texts: readonly string[]): SurfaceEdit[] {
  const visible = run.filter((node) => node.role !== "spine" || node.text !== null);
  if (visible.length === texts.length && visible.every((node, index) => shows(node, texts[index]!))) return [];
  if (texts.length === 0) return [replace(run, null)];
  if (run.length < texts.length) {
    throw new SpineDshError(`${texts.length} Spine items do not fit ${run.length} surface nodes`);
  }
  const head = run.length - texts.length + 1;
  const parts = [run.slice(0, head), ...run.slice(head).map((node) => [node])];
  return parts.flatMap((part, index) =>
    part.length === 1 && shows(part[0]!, texts[index]!) ? [] : [replace(part, texts[index]!)]);
}

function shows(node: SurfaceNode, text: string): boolean {
  return node.role === "spine" && node.text === text;
}

function replace(nodes: readonly SurfaceNode[], text: string | null): SurfaceEdit {
  return {
    type: "replace",
    startSeq: nodes[0]!.seq,
    endSeq: nodes.at(-1)!.seq,
    shadowed: nodes.map((node) => node.seq),
    text,
  };
}

/** Log the edits in the open step. A replaced range shows one slot or one item. */
export function applySurfaceEdits(session: Session, edits: readonly SurfaceEdit[], turn: number, step: number): void {
  for (const edit of edits) {
    if (edit.type === "append") {
      session.append("user/message", spineMessage(edit.text), { surfaceOp: "append" });
      continue;
    }
    const placement = {
      surfaceOp: { op: "replace" as const, startSeq: edit.startSeq, endSeq: edit.endSeq },
      sourceEventSeqs: edit.shadowed,
    };
    if (edit.text === null) {
      session.append("developer/message", { turn, step, message: emptySlot() }, placement);
    } else {
      session.append("user/message", spineMessage(edit.text), placement);
    }
  }
}
