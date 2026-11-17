// The dock's browser UI: the execution cursor's summary, expanding into the
// whole current tree. client.ts registers it; Vite (vite.config.ts) bundles
// both into dist/client.js, with the styles inlined in that bundle.
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  IconBranchOutlineRegular,
  IconCheckCircleOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseCircleFillRegular,
  IconCompactOutlineRegular,
  IconInspectOutlineRegular,
  IconWarningTriangleOutlineRegular,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { spineTreeLabel, spineTreeSpawnOutcome, type DisplayNode } from "@spinejit/spine-sdk/view";

import styles from "./spine-dock.css?inline";
import { showsTree, TREE_PROJECTION, type SpineView } from "../src/tree.js";

/** The dock seat's props the entry reads, plus what the entry wires in for it. */
export interface SpineDockProps {
  useProjection(key: typeof TREE_PROJECTION): SpineView | undefined;
  sessionId: string;
  /** Raise or clear the session's composer block: why its input is inert. */
  setBlock(sessionId: string, reason: string | null): void;
  /** Open a new session in the current workspace. */
  newSession(): void;
}

interface DockRow {
  node: DisplayNode;
  depth: number;
  hasChildren: boolean;
}

interface IndexedTree {
  byParent: Map<string | null, DisplayNode[]>;
  byId: Map<string, DisplayNode>;
}

type MarkerTone = "success" | "error" | "warn" | "dim";

interface Marker {
  icon: ReactNode;
  tone: MarkerTone;
  label: string;
}

const BODY_ID = "spinejit-dock-body";

/** In the composer of a session whose log began before Spine: what to do instead. */
const LEGACY_REASON = "This session began before Spine. Start a new session to continue.";

/** In the dock of that session: why the tree does not cover it. */
const LEGACY_NOTICE = "This session's history is outside the Spine tree.";

/**
 * The dock entry: a collapsed summary of the cursor, expanding into the whole
 * current tree. It renders nothing until the session has opened a task, so a
 * new conversation shows no Tree bar, and none for a history the tree cannot
 * cover either.
 */
export function SpineDock({ useProjection, sessionId, setBlock, newSession }: SpineDockProps): ReactElement | null {
  const view = useProjection(TREE_PROJECTION);
  const tree = view?.tree ?? null;
  const legacy = view?.legacy === true;
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [locateNonce, setLocateNonce] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const cursorRow = useRef<HTMLDivElement | null>(null);

  const shown = tree !== null && showsTree(tree) ? tree : null;
  // A root epoch only holds the tasks under it. The pinned tree never draws one,
  // and a row that says "Epoch 1" tells the reader nothing, so neither does this.
  const nodes = useMemo(
    () => shown === null ? [] : shown.nodes.filter((node) => node.kind !== "RootEpoch"),
    [shown],
  );
  const index = useMemo(() => indexTree(nodes), [nodes]);
  const rows = useMemo(() => visibleRows(index, collapsed), [index, collapsed]);
  const cursorNode = shown === null ? null : nodes.find((node) => node.nodeId === shown.cursor) ?? null;

  const revealCursorPath = useCallback(() => {
    if (cursorNode === null) return;
    setCollapsed((current) => {
      let next = current;
      let parentId = cursorNode.parentId;
      while (parentId !== null) {
        if (next.has(parentId)) {
          if (next === current) next = new Set(current);
          next.delete(parentId);
        }
        parentId = index.byId.get(parentId)?.parentId ?? null;
      }
      return next;
    });
  }, [cursorNode, index]);

  const toggleBranch = useCallback((nodeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const scrollToCursor = () => {
    const box = scroller.current;
    if (box === null) return;
    const row = cursorRow.current;
    // Nothing is open: the newest rows are the ones worth showing.
    if (row === null) {
      box.scrollTop = box.scrollHeight;
      return;
    }
    const boxRect = box.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    box.scrollTop += rowRect.top - boxRect.top - (box.clientHeight - rowRect.height) / 2;
  };

  useEffect(() => {
    if (!open) return;
    scrollToCursor();
  }, [open, locateNonce]);

  // The host marks a session whose log began before Spine, where the tree
  // cannot account for its history: say so, and leave its input inert here
  // rather than let it grow a history the tree does not cover. Page-local, as
  // the block registry is: leaving the session clears it.
  useEffect(() => {
    if (!legacy) return;
    setBlock(sessionId, LEGACY_REASON);
    return () => setBlock(sessionId, null);
  }, [legacy, sessionId, setBlock]);

  if (view === undefined) return null;
  // Nothing to show: a session that has not opened a task yet gets no dock at all.
  if (shown === null && !legacy) return null;

  const summary = shown === null
    ? "Started before Spine"
    : cursorNode === null ? "No node open" : spineTreeLabel(cursorNode, true);

  return (
    <section className="sj-dock" data-open={open ? "true" : "false"} aria-label="Spine Tree">
      <style>{styles}</style>
      <div className="sj-heading">
        <button
          type="button"
          className="sj-header"
          aria-expanded={open ? "true" : "false"}
          aria-controls={BODY_ID}
          aria-label={`Spine Tree: ${summary}`}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            revealCursorPath();
            setOpen(true);
            setLocateNonce((value) => value + 1);
          }}
        >
          <span className="sj-lead" aria-hidden="true">
            <IconBranchOutlineRegular size={16} />
          </span>
          <Tooltip label={summary} side="top" delayMs={400} onlyWhenClipped portal>
            <span className="sj-summary">{summary}</span>
          </Tooltip>
          <span className="sj-chevron" aria-hidden="true">
            {open ? <IconChevronDownOutlineRegular size={16} /> : <IconChevronUpOutlineRegular size={16} />}
          </span>
        </button>
        {open && cursorNode !== null
          ? (
            <Tooltip label="Locate current node" side="top" delayMs={300} portal>
              <span className="sj-locateWrap">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="sj-locate"
                  aria-label="Locate current node"
                  onClick={() => {
                    revealCursorPath();
                    setLocateNonce((value) => value + 1);
                  }}
                >
                  <IconInspectOutlineRegular size={14} />
                </Button>
              </span>
            </Tooltip>
          )
          : null}
      </div>
      {open
        ? (
          <div className="sj-body" id={BODY_ID}>
            {legacy
              ? (
                <div className="sj-legacy">
                  <span className="sj-legacyText">{LEGACY_NOTICE}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={newSession}>New session</Button>
                </div>
              )
              : null}
            {shown === null
              ? null
              : (
                <div
                  className="sj-scroll"
                  ref={scroller}
                  role="tree"
                  tabIndex={0}
                  aria-label="Spine nodes"
                >
                  {rows.map((row) => rowElement(row, shown.cursor, collapsed, toggleBranch, cursorRow))}
                </div>
              )}
          </div>
        )
        : null}
    </section>
  );
}

function rowElement(
  row: DockRow,
  cursor: string,
  collapsed: ReadonlySet<string>,
  onToggle: (nodeId: string) => void,
  cursorRow: { current: HTMLDivElement | null },
): ReactElement {
  const { node, depth } = row;
  const current = node.nodeId === cursor;
  const label = spineTreeLabel(node, current);
  const marker = markerOf(node);
  const expandable = row.hasChildren;
  const expanded = !collapsed.has(node.nodeId);
  return (
    <div
      key={node.nodeId}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? (expanded ? "true" : "false") : undefined}
      aria-current={current ? "step" : undefined}
      data-current={current ? "true" : "false"}
      className="sj-row"
      title={`${label} · ${marker.label}`}
      style={{ paddingLeft: `${4 + depth * 16}px` }}
      ref={current ? cursorRow : undefined}
    >
      {expandable
        ? (
          <button
            type="button"
            className="sj-caret"
            aria-expanded={expanded ? "true" : "false"}
            aria-label={`${expanded ? "Collapse" : "Expand"}: ${label}`}
            onClick={() => onToggle(node.nodeId)}
          >
            {expanded ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
          </button>
        )
        : <span className="sj-caretSpacer" aria-hidden="true" />}
      <span className={`sj-mark ${marker.tone}`} role="img" aria-label={marker.label} title={marker.label}>
        {marker.icon}
      </span>
      <span className="sj-label">{label}</span>
    </div>
  );
}

function markerOf(node: DisplayNode): Marker {
  const outcome = spineTreeSpawnOutcome(node.spawn);
  if (outcome === "completed") {
    return { icon: <IconCheckCircleOutlineRegular size={12} />, tone: "success", label: "Spawn completed" };
  }
  if (outcome === "errored") {
    return { icon: <IconCloseCircleFillRegular size={12} />, tone: "error", label: "Spawn errored" };
  }
  if (outcome === "aborted") {
    return { icon: <IconWarningTriangleOutlineRegular size={12} />, tone: "warn", label: "Spawn aborted" };
  }
  if (node.spawn === "pending") {
    return { icon: <StateDot state="ongoing" />, tone: "dim", label: "Spawn pending" };
  }
  if (node.spawn === "inherited") {
    return { icon: <StateDot state="idle" />, tone: "dim", label: "Inherited spawn" };
  }
  if (node.kind === "RootEpoch") {
    return { icon: <StateDot state="idle" />, tone: "dim", label: "Root epoch" };
  }
  if (node.status === "Live") {
    return { icon: <StateDot state="ongoing" />, tone: "success", label: "Live" };
  }
  if (node.status === "Opened") {
    return { icon: <StateDot state="idle" />, tone: "dim", label: "Opened" };
  }
  if (node.status === "Compacted") {
    return { icon: <IconCompactOutlineRegular size={12} />, tone: "warn", label: "Compacted" };
  }
  // Closed and an arrived Spawn are both work that finished: one mark for both,
  // as the pinned tree draws them.
  return { icon: <IconCheckCircleOutlineRegular size={12} />, tone: "success", label: "Closed" };
}

function indexTree(nodes: readonly DisplayNode[]): IndexedTree {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const byParent = new Map<string | null, DisplayNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const siblings = byParent.get(parentId);
    if (siblings === undefined) byParent.set(parentId, [node]);
    else siblings.push(node);
  }
  return { byParent, byId };
}

function visibleRows(index: IndexedTree, collapsed: ReadonlySet<string>): DockRow[] {
  const rows: DockRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of index.byParent.get(parentId) ?? []) {
      const children = index.byParent.get(node.nodeId) ?? [];
      rows.push({ node, depth, hasChildren: children.length > 0 });
      if (!collapsed.has(node.nodeId)) walk(node.nodeId, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
