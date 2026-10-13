import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Edge } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Analysis } from "../../shared/types.ts";
import { api, type Status } from "./api.ts";
import { AiPanel } from "./components/AiPanel.tsx";
import { FilePanel } from "./components/FilePanel.tsx";
import { nodeTypes } from "./components/FileNode.tsx";
import { Home } from "./components/Home.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Treemap } from "./components/Treemap.tsx";
import {
  buildDependencyGraph,
  buildReadingGraph,
  buildTreeGraph,
  defaultCollapsed,
  VIEW_MODES,
  type FlowNode,
  type ViewMode,
} from "./graph.ts";

function readHash(): string | null {
  return /^#\/a\/([\w-]+)/.exec(location.hash)?.[1] ?? null;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loadingHash, setLoadingHash] = useState(() => !!readHash());

  useEffect(() => {
    api.status().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    const sync = () => {
      const id = readHash();
      if (!id) {
        setAnalysis(null);
        return;
      }
      if (analysis?.id === id) return;
      setLoadingHash(true);
      api
        .load(id)
        .then(setAnalysis, () => {
          history.replaceState(null, "", "#/");
          setAnalysis(null);
        })
        .finally(() => setLoadingHash(false));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [analysis?.id]);

  const open = (a: Analysis) => {
    setAnalysis(a);
    location.hash = `#/a/${a.id}`;
  };

  if (loadingHash && !analysis) return <div className="center muted">読み込み中…</div>;
  if (!analysis) return <Home status={status} onLoaded={open} />;
  return (
    <ReactFlowProvider>
      <Workspace key={analysis.id} analysis={analysis} aiEnabled={status?.ai.available ?? false} onHome={() => (location.hash = "#/")} />
    </ReactFlowProvider>
  );
}

function Workspace({ analysis, aiEnabled, onHome }: { analysis: Analysis; aiEnabled: boolean; onHome: () => void }) {
  const [mode, setMode] = useState<ViewMode>("reading");
  const [selected, setSelected] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [right, setRight] = useState<"file" | "ai" | null>(null);
  const [aiTab, setAiTab] = useState<"overview" | "chat">("overview");
  const [collapsed, setCollapsed] = useState(() => defaultCollapsed(analysis.files));
  const [secCollapsed, setSecCollapsed] = useState<Set<string>>(() => new Set());
  const [showIsolated, setShowIsolated] = useState(false);
  const [hideTests, setHideTests] = useState(true);
  const [hideAux, setHideAux] = useState(true);
  const [query, setQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);

  const openFile = useCallback((path: string, line?: number) => {
    setSelected(path);
    setFocusLine(line ?? null);
    setRight("file");
    setFocusRequest((n) => n + 1);
  }, []);

  // 選択ファイルが折りたたまれたフォルダ内にある場合は親フォルダを開く
  useEffect(() => {
    if (!selected) return;
    const parents = selected.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    const expand = (s: Set<string>) => (parents.some((p) => s.has(p)) ? new Set([...s].filter((x) => !parents.includes(x))) : s);
    if (mode === "structure") setCollapsed(expand);
    if (mode === "security") setSecCollapsed(expand);
  }, [selected, mode]);

  const graph = useMemo((): { nodes: FlowNode[]; edges: Edge[]; note?: string } | null => {
    switch (mode) {
      case "structure":
        return buildTreeGraph(analysis, collapsed, { selected });
      case "security": {
        if (!analysis.findings.length) return { nodes: [], edges: [], note: "静的チェックでは問題は見つかりませんでした。" };
        return buildTreeGraph(analysis, secCollapsed, { securityOnly: true, selected });
      }
      case "dependency": {
        const g = buildDependencyGraph(analysis, { selected, showIsolated, hideTests, hideAux });
        return { ...g, note: g.truncated ? `ファイル数が多いため、つながりの多い上位ファイルのみ表示しています (${g.truncated} 件省略)` : undefined };
      }
      case "reading":
        return buildReadingGraph(analysis, selected);
      default:
        return null;
    }
  }, [analysis, mode, collapsed, secCollapsed, selected, showIsolated, hideTests, hideAux]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return analysis.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 10);
  }, [analysis, query]);

  const onNodeClick = (node: FlowNode) => {
    if (node.data.kind === "folder") {
      if (!node.data.path) return;
      const toggle = (s: Set<string>) => {
        const n = new Set(s);
        if (n.has(node.data.path)) n.delete(node.data.path);
        else n.add(node.data.path);
        return n;
      };
      if (mode === "structure") setCollapsed(toggle);
      else setSecCollapsed(toggle);
      return;
    }
    openFile(node.data.path);
  };

  return (
    <div className="workspace">
      <header className="topbar">
        <button className="brand" onClick={onHome} title="トップへ戻る">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <circle cx="9" cy="10" r="3" fill="white" />
            <circle cx="23" cy="10" r="3" fill="white" />
            <circle cx="16" cy="23" r="3" fill="white" />
            <path d="M9 10L16 23L23 10" stroke="white" strokeWidth="2" fill="none" />
          </svg>
          CodeMap
        </button>
        <div className="repo-name">
          <strong>{analysis.name}</strong>
          {analysis.source.startsWith("https://") ? (
            <a className="muted small" href={analysis.source} target="_blank" rel="noreferrer">{analysis.source}</a>
          ) : (
            <span className="muted small">{analysis.source}</span>
          )}
        </div>
        <nav className="modes">
          {VIEW_MODES.map((m) => (
            <button key={m.id} className={mode === m.id ? "active" : ""} onClick={() => setMode(m.id)} title={m.hint}>
              {m.label}
              {m.id === "security" && analysis.findings.length > 0 && <span className="mode-count">{analysis.findings.length}</span>}
            </button>
          ))}
        </nav>
        <div className="search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ファイルを検索" />
          {matches.length > 0 && (
            <ul className="search-results">
              {matches.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      openFile(f.path);
                      setQuery("");
                    }}
                  >
                    {f.path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className={`ai-btn ${right === "ai" ? "active" : ""}`} onClick={() => setRight(right === "ai" ? null : "ai")}>
          ✦ AI
        </button>
      </header>

      <div className="main">
        <Sidebar analysis={analysis} mode={mode} selected={selected} onOpen={openFile} />
        <section className="canvas">
          {mode === "dependency" && (
            <div className="canvas-toolbar">
              <label><input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} /> テストを隠す</label>
              <label><input type="checkbox" checked={hideAux} onChange={(e) => setHideAux(e.target.checked)} /> サンプル・ドキュメントを隠す</label>
              <label><input type="checkbox" checked={showIsolated} onChange={(e) => setShowIsolated(e.target.checked)} /> つながりのないファイルも表示</label>
            </div>
          )}
          {(mode === "structure" || mode === "security") && (
            <div className="canvas-toolbar">
              <span className="muted small">フォルダをクリックで開閉</span>
              <button className="chip" onClick={() => (mode === "structure" ? setCollapsed(new Set()) : setSecCollapsed(new Set()))}>すべて開く</button>
              {mode === "structure" && <button className="chip" onClick={() => setCollapsed(defaultCollapsed(analysis.files, 30))}>折りたたむ</button>}
            </div>
          )}
          {mode === "reading" && (
            <div className="canvas-toolbar">
              <span className="muted small">番号順に読むと全体像がつかみやすくなります。ノードをクリックすると中身と解説を表示します。</span>
            </div>
          )}
          {graph?.note && <div className="canvas-note">{graph.note}</div>}
          {mode === "complexity" ? (
            <Treemap analysis={analysis} selected={selected} onSelect={openFile} />
          ) : (
            graph && (
              <Flow key={mode} nodes={graph.nodes} edges={graph.edges} onNodeClick={onNodeClick} focusPath={selected} focusRequest={focusRequest} mode={mode} />
            )
          )}
        </section>
        {right === "file" && selected && (
          <FilePanel analysis={analysis} path={selected} focusLine={focusLine} onOpen={openFile} onClose={() => setRight(null)} aiEnabled={aiEnabled} />
        )}
        {right === "ai" && (
          <AiPanel analysis={analysis} tab={aiTab} onTab={setAiTab} selected={selected} onOpen={openFile} onClose={() => setRight(null)} aiEnabled={aiEnabled} />
        )}
      </div>
    </div>
  );
}

function Flow({
  nodes,
  edges,
  onNodeClick,
  focusPath,
  focusRequest,
  mode,
}: {
  nodes: FlowNode[];
  edges: Edge[];
  onNodeClick: (n: FlowNode) => void;
  focusPath: string | null;
  focusRequest: number;
  mode: ViewMode;
}) {
  const flow = useReactFlow();

  // 検索やリストからファイルを開いたとき、そのノードへ移動する
  useEffect(() => {
    if (!focusPath || !focusRequest) return;
    const id = mode === "structure" || mode === "security" ? `file:${focusPath}` : focusPath;
    const timer = setTimeout(() => {
      const n = flow.getNode(id);
      if (n) void flow.setCenter(n.position.x + 105, n.position.y + 23, { zoom: Math.max(flow.getZoom(), 0.9), duration: 400 });
    }, 50);
    return () => clearTimeout(timer);
  }, [focusRequest]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onNodeClick(n as FlowNode)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
      minZoom={0.05}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      onlyRenderVisibleElements={nodes.length > 300}
    >
      <Background gap={24} size={1} color="var(--grid)" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => (n.data as FlowNode["data"]).color} nodeStrokeWidth={0} />
    </ReactFlow>
  );
}
