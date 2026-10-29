import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi, type KeybindingsManager, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { SpineTreeView } from "../tree-view-contract.js";
import {
  spineTreeBranch,
  spineTreeBrand,
  spineTreeChildPrefix,
  spineTreeLabel,
  spineTreeMarker,
  spineTreeMarkerText,
} from "../tree-style.js";

import type { NavigationData, NavigationNode } from "./data.js";

interface BrowserOptions {
  data: NavigationData;
  initialNodeId?: string;
  theme: Pick<Theme, "fg" | "bold">;
  markdownTheme: MarkdownTheme;
  keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
  redraw(): void;
  close(): void;
}

/** One view in the core-owned widget; its input controller lives in Pi custom(). */
export class SpineTreeBrowser implements SpineTreeView {
  private readonly byId: Map<string, NavigationNode>;
  private readonly expanded = new Set<string>();
  private selected: string;
  private reading = false;
  private fullMemory = false;
  private memorySectionIndex = 0;
  private memorySectionOffset = 0;
  private pendingScroll = 0;
  private pageHeight = 1;
  private memorySections: readonly string[] | undefined;
  private readonly memoryDocuments = new Map<number, Markdown>();
  private readonly memoryLines = new Map<string, string[]>();

  constructor(private readonly options: BrowserOptions) {
    this.byId = new Map(options.data.nodes.map(node => [node.id, node]));
    const initial = options.initialNodeId ?? options.data.cursor;
    this.selected = this.byId.has(initial) ? initial : options.data.nodes[0]?.id ?? "";
    // Open as the bottom tree shows it: the selected node's path and its children.
    for (let id: string | null | undefined = this.selected; id; id = this.byId.get(id)?.parent) this.expanded.add(id);
    this.locateSelected();
    if (options.initialNodeId && this.byId.has(options.initialNodeId)) {
      this.reading = true;
    }
  }

  invalidate(): void {
    for (const document of this.memoryDocuments.values()) document.invalidate();
    this.memoryLines.clear();
  }

  render(width: number, maxHeight: number): string[] {
    if (width < 1 || maxHeight < 1) return [];
    const fit = (line: string) => truncateToWidth(line, width, "");
    const node = this.byId.get(this.selected);
    if (!node) return [fit("Spine Tree: no nodes")];
    if (width < 12 || maxHeight < 5) {
      return [fit(`> ${node.id} ${node.summary}`), fit("Enlarge terminal; cancel exits")].slice(0, maxHeight);
    }

    const visible = this.visibleNodes();
    const treeHeight = Math.min(8, visible.length, Math.max(1, Math.floor((maxHeight - 3) / 2)));
    const bodyHeight = this.reading
      ? Math.max(1, Math.min(16, maxHeight - treeHeight - 3))
      : 0;
    this.pageHeight = bodyHeight;
    const body = this.renderBody(width, bodyHeight);
    while (body.length < bodyHeight) body.push("");
    const index = visible.findIndex(row => row.node.id === this.selected);
    const first = Math.max(0, Math.min(index - Math.floor(treeHeight / 2), visible.length - treeHeight));
    const tree = visible.slice(first, first + treeHeight).map(({ node: item, prefix, isLast }) => {
      const selected = item.id === this.selected;
      const hasChildren = item.children.length > 0;
      const status = spineTreeMarker(item, item.id === this.options.data.cursor, hasChildren, this.expanded.has(item.id));
      const selectPrefix = selected ? this.options.theme.fg("accent", "> ") : "  ";
      const branchText = this.options.theme.fg("dim", `${prefix}${spineTreeBranch(isLast)}`);
      const markerText = spineTreeMarkerText(status, this.options.theme);
      const text = `${selectPrefix}${branchText}${markerText} ${this.options.theme.fg("dim", item.id)} ${selected ? this.options.theme.bold(spineTreeLabel(item, item.id === this.options.data.cursor)) : spineTreeLabel(item, item.id === this.options.data.cursor)}`;
      return text;
    });
    const sectionCount = this.memorySections?.length ?? 0;
    const title = `Memory · ${node.id} · ${this.fullMemory ? "full memory" : "summary"} · section ${this.memorySectionIndex + 1}/${Math.max(1, sectionCount)} · line ${this.memorySectionOffset + 1}`;
    return [
      ...(this.reading ? [this.options.theme.fg("accent", title), ...body, this.options.theme.fg("dim", "─".repeat(width))] : []),
      `${this.options.theme.fg("dim", "• ")}${spineTreeBrand("Spine Tree", this.options.theme)}${this.options.theme.fg("dim", visible.length > treeHeight ? ` · ${index + 1}/${visible.length}` : "")}`,
      ...tree,
    ].map(fit).slice(0, maxHeight);
  }

  renderControls(width: number): string[] {
    const keys = this.options.keybindings;
    const glyphs: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", enter: "Enter", tab: "Tab", pageUp: "PgUp", pageDown: "PgDn", pageup: "PgUp", pagedown: "PgDn" };
    const key = (action: Parameters<typeof keys.getKeys>[0]) => {
      const binding = keys.getKeys(action)[0] ?? "unbound";
      return this.options.theme.fg("accent", glyphs[binding] ?? binding);
    };
    const pair = (a: Parameters<typeof keys.getKeys>[0], b: Parameters<typeof keys.getKeys>[0]) => `${key(a)}/${key(b)}`;
    const controls = this.reading
      ? [ `${pair("tui.select.up", "tui.select.down")} scroll`, `${pair("tui.select.pageUp", "tui.select.pageDown")} page`, `${key("tui.input.tab")} ${this.fullMemory ? "summary" : "full memory"}`, `${key("tui.select.cancel")} back` ]
      : [ `${pair("tui.select.up", "tui.select.down")} select`, `${pair("tui.editor.cursorLeft", "tui.editor.cursorRight")} collapse/expand`, `${key("tui.select.confirm")} read memory`, `${key("tui.select.cancel")} exit` ];
    return width > 0 ? wrapTextWithAnsi(this.options.theme.fg("dim", controls.join(" · ")), width) : [];
  }

  handleInput(input: string): void {
    const match = (action: Parameters<BrowserOptions["keybindings"]["matches"]>[1]) => this.options.keybindings.matches(input, action);
    if (match("tui.select.cancel")) {
      if (this.reading) this.reading = false;
      else { this.options.close(); return; }
    } else if (match("tui.input.tab")) {
      if (!this.reading) return;
      this.toggleMemory();
    } else if (match("tui.select.confirm")) {
      this.reading = true;
      this.pendingScroll = 0;
    } else if (match("tui.select.pageUp") || match("tui.select.pageDown")) {
      if (this.reading) this.pendingScroll += (match("tui.select.pageUp") ? -1 : 1) * this.pageHeight;
    } else if (match("tui.select.up") || match("tui.select.down")) {
      const delta = match("tui.select.up") ? -1 : 1;
      if (this.reading) this.pendingScroll += delta;
      else {
        const visible = this.visibleNodes();
        const index = visible.findIndex(row => row.node.id === this.selected);
        const target = visible[Math.max(0, Math.min(visible.length - 1, index + delta))];
        if (target) this.select(target.node.id);
      }
    } else if (match("tui.editor.cursorLeft") || match("tui.editor.cursorRight")) {
      if (!this.reading) {
        const node = this.byId.get(this.selected);
        if (node && match("tui.editor.cursorLeft")) {
          if (!this.expanded.delete(node.id) && node.parent) this.select(node.parent);
        } else if (node) {
          if (!this.expanded.has(node.id)) this.expanded.add(node.id);
          else if (node.children[0]) this.select(node.children[0]);
        }
      }
    } else return;
    this.options.redraw();
  }

  private visibleNodes(): Array<{ node: NavigationNode; depth: number; prefix: string; isLast: boolean }> {
    const output: Array<{ node: NavigationNode; depth: number; prefix: string; isLast: boolean }> = [];
    const visit = (node: NavigationNode, depth: number, prefix: string, isLast: boolean): void => {
      output.push({ node, depth, prefix, isLast });
      if (!this.expanded.has(node.id)) return;
      const children = node.children
        .map(id => this.byId.get(id))
        .filter((child): child is NavigationNode => child !== undefined);
      children.forEach((child, index) => {
        visit(child, depth + 1, `${prefix}${spineTreeChildPrefix(isLast)}`, index === children.length - 1);
      });
    };
    const roots = this.options.data.nodes.filter(node => node.parent === null);
    roots.forEach((root, index) => visit(root, 0, "", index === roots.length - 1));
    return output;
  }

  private select(id: string): void {
    if (id === this.selected) return;
    this.selected = id;
    this.fullMemory = false;
    this.locateSelected();
  }

  private locateSelected(): void {
    this.memorySections = undefined;
    this.memorySectionIndex = 0;
    this.memorySectionOffset = 0;
    this.pendingScroll = 0;
    this.memoryDocuments.clear();
    this.memoryLines.clear();
  }

  private document(text: string): Markdown {
    return new Markdown(text, 0, 0, this.options.markdownTheme);
  }

  private renderBody(width: number, height: number): string[] {
    const scroll = this.pendingScroll;
    this.pendingScroll = 0;
    if (!this.reading) return [];
    this.memorySections ??= this.options.data.memorySections(this.selected, this.fullMemory);
    if (this.memorySections.length === 0) return [];
    this.moveMemory(width, scroll);
    const output: string[] = [];
    let section = this.memorySectionIndex;
    let offset = this.memorySectionOffset;
    while (output.length < height && section < this.memorySections.length) {
      const lines = this.sectionLines(section, width);
      output.push(...lines.slice(offset, offset + height - output.length));
      section++;
      offset = 0;
    }
    return output;
  }

  private toggleMemory(): void {
    this.fullMemory = !this.fullMemory;
    this.memorySections = undefined;
    this.memorySectionIndex = 0;
    this.memorySectionOffset = 0;
    this.pendingScroll = 0;
    this.memoryDocuments.clear();
    this.memoryLines.clear();
  }

  private sectionLines(index: number, width: number): string[] {
    const key = `${index}:${width}`;
    const cached = this.memoryLines.get(key);
    if (cached) return cached;
    const section = this.memorySections?.[index] ?? "";
    let document = this.memoryDocuments.get(index);
    if (!document) {
      document = this.document(section);
      this.memoryDocuments.set(index, document);
    }
    const lines = document.render(width);
    this.memoryLines.set(key, lines);
    return lines;
  }

  private moveMemory(width: number, delta: number): void {
    while (delta < 0) {
      this.memorySectionOffset += delta;
      if (this.memorySectionOffset >= 0 || this.memorySectionIndex === 0) break;
      this.memorySectionIndex--;
      this.memorySectionOffset += this.sectionLines(this.memorySectionIndex, width).length;
    }
    while (delta > 0) {
      const lines = this.sectionLines(this.memorySectionIndex, width);
      const remaining = Math.max(0, lines.length - this.memorySectionOffset - 1);
      if (delta <= remaining) {
        this.memorySectionOffset += delta;
        break;
      }
      delta -= remaining + 1;
      if (this.memorySectionIndex + 1 >= (this.memorySections?.length ?? 0)) {
        this.memorySectionOffset = Math.max(0, lines.length - 1);
        break;
      }
      this.memorySectionIndex++;
      this.memorySectionOffset = 0;
    }
    const current = this.sectionLines(this.memorySectionIndex, width);
    this.memorySectionOffset = Math.min(this.memorySectionOffset, Math.max(0, current.length - 1));
  }
}
