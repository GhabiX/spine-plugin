import type {} from "@deepseek-ai/dsh-compaction";
import { deriveEventMessage, type Session, type SessionSeq } from "@deepseek-ai/dsh-session";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
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
  /**
   * A logged source event shown as it is; `anchor` is its `[U<n>]`, if any;
   * `withoutReasoning`, a model output shown without its reasoning.
   */
  | { type: "source"; seq: SessionSeq; anchor: number | null; withoutReasoning: boolean }
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
): PlanItem[] {
  const plan = context.contextPlan;
  if (plan === null) throw new SpineDshError("Spine published no context plan");
  return plan.cells.map((cell) => planItem(cell, seqOf));
}

function planItem(
  cell: ContextPlanCell,
  seqOf: (id: EpochOrdinalId) => SessionSeq,
): PlanItem {
  if (cell.type === "source") {
    const anchors = cell.labels.flatMap((label) => (label === "WithoutReasoning" ? [] : [label.UserAnchor]));
    if (anchors.length > 1) throw new SpineDshError(`source ${seqOf(cell.source_id)} has ${anchors.length} user anchors`);
    return {
      type: "source",
      seq: seqOf(cell.source_id),
      anchor: anchors[0] ?? null,
      withoutReasoning: cell.labels.includes("WithoutReasoning"),
    };
  }
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const { node_id: nodeId, summary, status } = item.SyntheticNode;
    return { type: "spine", text: spineNodeText(nodeId, summary, status) };
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
 * alone. Otherwise each item occupies one node, and unused nodes become
 * invisible slots. Keeping the run's positions lets a later fold put more
 * items in the same gap between anchors without inserting into the surface.
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
  if (run.length < texts.length) {
    throw new SpineDshError(`${texts.length} Spine items do not fit ${run.length} surface nodes`);
  }
  // Reuse the visible prefix, including empty slots before it, whenever there
  // is still room for the rest. The fill that follows keeps every position.
  let start = 0;
  let matched = 0;
  for (let i = 0; matched < texts.length && run.length - i >= texts.length - matched; i += 1) {
    const node = run[i]!;
    if (shows(node, null)) continue;
    if (!shows(node, texts[matched]!)) break;
    start = i + 1;
    matched += 1;
  }
  return run.slice(start).flatMap((node, index) => {
    const text = texts[matched + index] ?? null;
    return shows(node, text) ? [] : [replace(node, text)];
  });
}

function shows(node: SurfaceNode, text: string | null): boolean {
  return node.role === "spine" && node.text === text;
}

function replace(node: SurfaceNode, text: string | null): SurfaceEdit {
  return {
    type: "replace",
    startSeq: node.seq,
    endSeq: node.seq,
    shadowed: [node.seq],
    text,
  };
}

/** Log the edits in the open step. Each replacement preserves its position. */
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
    // The native meter subtracts the old message's price only when the
    // replacement immediately follows its shadow-price record.
    const shadowedTokenCount = edit.shadowed.reduce((tokens, seq) => {
      const event = session.eventAt(seq);
      if (event === undefined) throw new SpineDshError(`session event ${seq} was never seen`);
      const message = deriveEventMessage(event);
      return tokens + (message === null ? 0 : estimateMessage(message));
    }, 0);
    session.append("compaction/prune", {
      shadowedRange: { start: edit.startSeq, end: edit.endSeq },
      shadowedSeqs: edit.shadowed,
      shadowedTokenCount,
    });
    if (edit.text === null) {
      session.append("developer/message", { turn, step, message: emptySlot() }, placement);
    } else {
      session.append("user/message", spineMessage(edit.text), placement);
    }
  }
}
