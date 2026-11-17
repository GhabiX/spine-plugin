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
  IconStopFillRegular,
  IconWarningTriangleOutlineRegular,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { spineTreeLabel, spineTreeSpawnOutcome, type DisplayNode } from "@spinejit/spine-sdk/view";

import styles from "./spine-dock.css?inline";
import { showsTree, TREE_PROJECTION, type SpineTree } from "../src/tree.js";

/** The dock seat's props the entry reads. */
export interface SpineDockProps {
  useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
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

/** The dock entry: a collapsed summary of the cursor, expanding into the whole current tree. */
export function SpineDock({ useProjection }: SpineDockProps): ReactElement | null {
  const tree = useProjection(TREE_PROJECTION);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [locateNonce, setLocateNonce] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const cursorRow = useRef<HTMLDivElement | null>(null);

  const shown = tree !== null && tree !== undefined && showsTree(tree) ? tree : null;
  const index = useMemo(() => indexTree(shown === null ? [] : shown.nodes), [shown]);
  const rows = useMemo(() => visibleRows(index, collapsed), [index, collapsed]);
  const cursorNode = shown === null ? null : shown.nodes.find((node) => node.nodeId === shown.cursor) ?? null;

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
    const row = cursorRow.current;
    if (box === null || row === null) return;
    const boxRect = box.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    box.scrollTop += rowRect.top - boxRect.top - (box.clientHeight - rowRect.height) / 2;
  };

  useEffect(() => {
    if (!open) return;
    scrollToCursor();
  }, [open, locateNonce]);

  if (tree === undefined) return null;

  const summary = shown === null
    ? "Waiting for the first Spine task"
    : cursorNode === null ? "Spine Tree" : labelOf(cursorNode, true);

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
            {shown === null
              ? <div className="sj-notice">The tree appears after Spine opens its first task.</div>
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
  const label = labelOf(node, current);
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
  return { icon: <IconStopFillRegular size={10} />, tone: "dim", label: "Closed" };
}

function labelOf(node: DisplayNode, current: boolean): string {
  if (node.kind === "RootEpoch") return node.summary?.trim() || `Epoch ${node.nodeId}`;
  return spineTreeLabel(node, current);
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
