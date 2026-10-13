// Analysis から React Flow のノード/エッジを組み立てる

import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Analysis, FileInfo, FileRole, Severity } from "../../shared/types.ts";
import { AUX_PATH } from "../../shared/languages.ts";

export type ViewMode = "structure" | "dependency" | "reading" | "security" | "complexity";

export const VIEW_MODES: Array<{ id: ViewMode; label: string; hint: string }> = [
  { id: "structure", label: "フォルダ構造", hint: "フォルダとファイルの階層をツリーで表示" },
  { id: "dependency", label: "依存関係", hint: "どのファイルがどのファイルを読み込んでいるか" },
  { id: "reading", label: "読む順番", hint: "どこから読めば理解しやすいかのガイド" },
  { id: "security", label: "セキュリティ", hint: "問題が見つかったファイルを危険度で色分け" },
  { id: "complexity", label: "複雑度マップ", hint: "ファイルの大きさと複雑さをヒートマップで表示" },
];

export const ROLE_LABEL: Record<FileRole, string> = {
  entry: "エントリー",
  config: "設定",
  test: "テスト",
  component: "UI部品",
  route: "ルート/API",
  model: "データ/型",
  util: "共通処理",
  style: "スタイル",
  doc: "ドキュメント",
  other: "その他",
};

export const ROLE_COLOR: Record<FileRole, string> = {
  entry: "#e5484d",
  config: "#8e8c99",
  test: "#3e9b4f",
  component: "#4f6bed",
  route: "#d6409f",
  model: "#f76b15",
  util: "#12a594",
  style: "#8e4ec6",
  doc: "#6e6e78",
  other: "#5b8def",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#c62a2f",
  high: "#e5484d",
  medium: "#f5a524",
  low: "#8e8c99",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "緊急",
  high: "高",
  medium: "中",
  low: "低",
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface FileNodeData extends Record<string, unknown> {
  kind: "file" | "folder";
  label: string;
  path: string;
  color: string;
  sub?: string;
  badge?: string;
  badgeColor?: string;
  dim?: boolean;
  highlight?: boolean;
  collapsed?: boolean;
  count?: number;
}

export type FlowNode = Node<FileNodeData>;

const NODE_W = 210;
const NODE_H = 46;

function layout(nodes: FlowNode[], edges: Edge[], rankdir: "LR" | "TB" = "LR", ranksep = 70, nodesep = 14): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, ranksep, nodesep, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, width: NODE_W, height: NODE_H, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

function baseName(p: string): string {
  return p.split("/").pop() || p;
}

function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// ---------------- フォルダ構造 / セキュリティ ----------------

interface Dir {
  path: string;
  dirs: Map<string, Dir>;
  files: FileInfo[];
  total: number;
}

function buildTree(files: FileInfo[]): Dir {
  const root: Dir = { path: "", dirs: new Map(), files: [], total: 0 };
  for (const f of files) {
    let cur = root;
    cur.total++;
    const parts = f.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { path: p, dirs: new Map(), files: [], total: 0 };
        cur.dirs.set(parts[i], next);
      }
      next.total++;
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

/** ノード数が上限を超えないように、浅い階層だけを開いた状態の折りたたみセットを作る */
export function defaultCollapsed(files: FileInfo[], limit = 70): Set<string> {
  const root = buildTree(files);
  const all: Array<{ dir: Dir; depth: number }> = [];
  const walk = (d: Dir, depth: number) => {
    for (const c of d.dirs.values()) {
      all.push({ dir: c, depth });
      walk(c, depth + 1);
    }
  };
  walk(root, 1);
  for (let maxDepth = 1; maxDepth <= 12; maxDepth++) {
    const collapsed = new Set(all.filter((x) => x.depth > maxDepth).map((x) => x.dir.path));
    if (countVisible(root, collapsed) > limit) {
      return new Set(all.filter((x) => x.depth >= Math.max(1, maxDepth)).map((x) => x.dir.path));
    }
  }
  return new Set();
}

function countVisible(d: Dir, collapsed: Set<string>): number {
  let n = d.files.length + d.dirs.size;
  for (const c of d.dirs.values()) if (!collapsed.has(c.path)) n += countVisible(c, collapsed) - 0;
  return n;
}

export function buildTreeGraph(
  a: Analysis,
  collapsed: Set<string>,
  opts: { securityOnly?: boolean; selected?: string | null },
): { nodes: FlowNode[]; edges: Edge[] } {
  const findingsByFile = new Map<string, { count: number; worst: Severity }>();
  for (const f of a.findings) {
    const cur = findingsByFile.get(f.file);
    if (!cur) findingsByFile.set(f.file, { count: 1, worst: f.severity });
    else {
      cur.count++;
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.worst]) cur.worst = f.severity;
    }
  }
  const files = opts.securityOnly ? a.files.filter((f) => findingsByFile.has(f.path)) : a.files;
  const root = buildTree(files);
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const rootId = "dir:";
  nodes.push({
    id: rootId,
    type: "file",
    position: { x: 0, y: 0 },
    data: { kind: "folder", label: a.name, path: "", color: "#4f6bed", sub: `${a.files.length} ファイル`, count: files.length },
  });

  const worstIn = (d: Dir): Severity | null => {
    let worst: Severity | null = null;
    const visit = (x: Dir) => {
      for (const f of x.files) {
        const s = findingsByFile.get(f.path)?.worst;
        if (s && (!worst || SEVERITY_RANK[s] > SEVERITY_RANK[worst])) worst = s;
      }
      x.dirs.forEach(visit);
    };
    visit(d);
    return worst;
  };
  const findingsIn = (d: Dir): number => {
    let n = 0;
    const visit = (x: Dir) => {
      for (const f of x.files) n += findingsByFile.get(f.path)?.count ?? 0;
      x.dirs.forEach(visit);
    };
    visit(d);
    return n;
  };

  const walk = (d: Dir, parentId: string) => {
    const dirs = [...d.dirs.values()].sort((x, y) => x.path.localeCompare(y.path));
    for (const c of dirs) {
      const id = `dir:${c.path}`;
      const isCollapsed = collapsed.has(c.path);
      const worst = opts.securityOnly ? worstIn(c) : null;
      nodes.push({
        id,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          kind: "folder",
          label: `${baseName(c.path)}/`,
          path: c.path,
          color: worst ? SEVERITY_COLOR[worst] : "#7c7f8c",
          sub: opts.securityOnly ? `${findingsIn(c)} 件の検出` : `${c.total} ファイル`,
          collapsed: isCollapsed,
          count: c.total,
        },
      });
      edges.push({ id: `${parentId}->${id}`, source: parentId, target: id, type: "smoothstep" });
      if (!isCollapsed) walk(c, id);
    }
    for (const f of [...d.files].sort((x, y) => x.path.localeCompare(y.path))) {
      const id = `file:${f.path}`;
      const sec = findingsByFile.get(f.path);
      nodes.push({
        id,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          kind: "file",
          label: baseName(f.path),
          path: f.path,
          color: opts.securityOnly && sec ? SEVERITY_COLOR[sec.worst] : ROLE_COLOR[f.role],
          sub: opts.securityOnly && sec ? `${sec.count} 件 · 最大: ${SEVERITY_LABEL[sec.worst]}` : `${f.lines} 行 · ${ROLE_LABEL[f.role]}`,
          badge: opts.securityOnly ? undefined : f.readingOrder ? `#${f.readingOrder}` : sec ? "⚠" : undefined,
          badgeColor: opts.securityOnly ? undefined : f.readingOrder ? "var(--accent)" : sec ? SEVERITY_COLOR[sec.worst] : undefined,
          highlight: opts.selected === f.path,
        },
      });
      edges.push({ id: `${parentId}->${id}`, source: parentId, target: id, type: "smoothstep" });
    }
  };
  walk(root, rootId);
  return { nodes: layout(nodes, edges, "LR", 60, 8), edges: edges.map((e) => ({ ...e, style: { stroke: "var(--edge)" } })) };
}

// ---------------- 依存関係 ----------------

const MAX_DEP_NODES = 350;

export function buildDependencyGraph(
  a: Analysis,
  opts: { selected: string | null; showIsolated: boolean; hideTests: boolean; hideAux: boolean },
): { nodes: FlowNode[]; edges: Edge[]; truncated: number } {
  let files = a.files.filter((f) => !(opts.hideTests && f.role === "test") && !(opts.hideAux && AUX_PATH.test(f.path)));
  const inSet = new Set(files.map((f) => f.path));
  const degree = (f: FileInfo) => f.imports.filter((p) => inSet.has(p)).length + f.importedBy.filter((p) => inSet.has(p)).length;
  if (!opts.showIsolated) files = files.filter((f) => degree(f) > 0 || f.role === "entry");
  let truncated = 0;
  if (files.length > MAX_DEP_NODES) {
    truncated = files.length - MAX_DEP_NODES;
    files = [...files].sort((x, y) => degree(y) - degree(x)).slice(0, MAX_DEP_NODES);
  }
  const visible = new Set(files.map((f) => f.path));
  const sel = opts.selected && visible.has(opts.selected) ? a.files.find((f) => f.path === opts.selected) : null;
  const neighbors = new Set(sel ? [sel.path, ...sel.imports, ...sel.importedBy] : []);

  const nodes: FlowNode[] = files.map((f) => ({
    id: f.path,
    type: "file",
    position: { x: 0, y: 0 },
    data: {
      kind: "file",
      label: baseName(f.path),
      path: f.path,
      color: ROLE_COLOR[f.role],
      sub: dirName(f.path) || "/",
      badge: f.importedBy.length > 1 ? `←${f.importedBy.length}` : undefined,
      dim: !!sel && !neighbors.has(f.path),
      highlight: sel?.path === f.path,
    },
  }));
  const edges: Edge[] = [];
  for (const f of files) {
    for (const t of f.imports) {
      if (!visible.has(t)) continue;
      const active = !!sel && (f.path === sel.path || t === sel.path);
      edges.push({
        id: `${f.path}->${t}`,
        source: f.path,
        target: t,
        animated: active,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: active ? "var(--accent)" : "var(--edge)" },
        style: { stroke: active ? "var(--accent)" : "var(--edge)", strokeWidth: active ? 2 : 1, opacity: sel && !active ? 0.15 : 1 },
      });
    }
  }
  return { nodes: layout(nodes, edges, "LR", 90, 12), edges, truncated };
}

// ---------------- 読む順番 ----------------

export function buildReadingGraph(a: Analysis, selected: string | null): { nodes: FlowNode[]; edges: Edge[] } {
  const perRow = 4;
  const gapX = 280;
  const gapY = 120;
  const byPath = new Map(a.files.map((f) => [f.path, f]));
  const nodes: FlowNode[] = a.readingOrder.map((step, i) => {
    const row = Math.floor(i / perRow);
    const col = row % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow);
    const f = byPath.get(step.path);
    return {
      id: step.path,
      type: "file",
      width: NODE_W,
      height: NODE_H,
      position: { x: col * gapX, y: row * gapY },
      data: {
        kind: "file",
        label: baseName(step.path),
        path: step.path,
        color: f ? ROLE_COLOR[f.role] : "#888",
        sub: dirName(step.path) || "/",
        badge: String(step.order),
        badgeColor: "var(--accent)",
        highlight: selected === step.path,
      },
    };
  });
  const edges: Edge[] = [];
  for (let i = 1; i < a.readingOrder.length; i++) {
    const prev = a.readingOrder[i - 1].path;
    const cur = a.readingOrder[i].path;
    const prevRow = Math.floor((i - 1) / perRow);
    const row = Math.floor(i / perRow);
    // 同じ行: 左→右 (偶数行) / 右→左 (奇数行)、行が変わるときは下→上
    const handles =
      prevRow !== row
        ? { sourceHandle: "b", targetHandle: "t" }
        : row % 2 === 0
          ? { sourceHandle: undefined, targetHandle: undefined }
          : { sourceHandle: "ls", targetHandle: "rt" };
    edges.push({
      id: `seq:${i}`,
      source: prev,
      target: cur,
      ...handles,
      type: "smoothstep",
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" },
      style: { stroke: "var(--accent)", strokeWidth: 2 },
    });
  }
  return { nodes, edges };
}
