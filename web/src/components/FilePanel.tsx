// 選択中ファイルの詳細: 概要 / コード / AI 解説 / AI セキュリティレビュー

import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "../../../shared/types.ts";
import { AI_DISABLED_MESSAGE, api } from "../api.ts";
import { ROLE_COLOR, ROLE_LABEL, SEVERITY_COLOR, SEVERITY_LABEL } from "../graph.ts";
import { useAiStream } from "../useAi.ts";
import { Markdown } from "./Markdown.tsx";

type Tab = "code" | "explain" | "security";

// 生成済みの AI 回答をセッション中は再利用する
const aiCache = new Map<string, string>();

export function FilePanel({
  analysis,
  path,
  focusLine,
  onOpen,
  onClose,
  aiEnabled,
}: {
  analysis: Analysis;
  path: string;
  focusLine: number | null;
  onOpen: (path: string, line?: number) => void;
  onClose: () => void;
  aiEnabled: boolean;
}) {
  const file = analysis.files.find((f) => f.path === path);
  const [content, setContent] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const ai = useAiStream(analysis.id);
  const codeRef = useRef<HTMLDivElement>(null);
  const paths = useMemo(() => new Set(analysis.files.map((f) => f.path)), [analysis]);
  const findings = analysis.findings.filter((f) => f.file === path);
  const findingLines = new Map(findings.map((f) => [f.line, f]));

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api.file(analysis.id, path).then((r) => !cancelled && setContent(r.content), () => !cancelled && setContent(""));
    return () => {
      cancelled = true;
    };
  }, [analysis.id, path]);

  useEffect(() => {
    ai.reset();
    if (tab !== "code") {
      const cached = aiCache.get(`${analysis.id}:${tab}:${path}`);
      if (cached) ai.setText(cached);
    }
  }, [path, tab]);

  useEffect(() => {
    if (focusLine) setTab("code");
  }, [focusLine, path]);

  useEffect(() => {
    if (tab !== "code" || !focusLine || !content) return;
    const el = codeRef.current?.querySelector(`[data-line="${focusLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [tab, focusLine, content]);

  if (!file) return null;

  const runAi = async (kind: "explain" | "security") => {
    const text = await ai.run(kind, { path });
    if (text) aiCache.set(`${analysis.id}:${kind}:${path}`, text);
  };

  return (
    <aside className="file-panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="role-dot" style={{ background: ROLE_COLOR[file.role] }} />
          <span className="mono" title={file.path}>{file.path}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </header>

      <div className="file-meta">
        <span className="tag">{file.language}</span>
        <span className="tag" style={{ borderColor: ROLE_COLOR[file.role] }}>{ROLE_LABEL[file.role]}</span>
        <span>{file.lines} 行</span>
        <span>関数 {file.functions}</span>
        <span>複雑度 {file.complexity}</span>
        {file.readingOrder && <span className="tag accent">読む順番 #{file.readingOrder}</span>}
      </div>
      {file.readingReason && <p className="reading-reason">{file.readingReason}</p>}

      <div className="relations">
        <Relation title={`読み込んでいる (${file.imports.length})`} items={file.imports} onOpen={onOpen} />
        <Relation title={`読み込まれている (${file.importedBy.length})`} items={file.importedBy} onOpen={onOpen} />
        {file.externalImports.length > 0 && (
          <div className="relation">
            <div className="relation-title">外部パッケージ</div>
            <div className="pkg-list">
              {file.externalImports.map((p) => (
                <span key={p} className="tag">{p}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {findings.length > 0 && (
        <div className="file-findings">
          {findings.map((f, i) => (
            <button key={i} className="finding-row" onClick={() => onOpen(path, f.line)}>
              <span className="sev" style={{ background: SEVERITY_COLOR[f.severity] }}>{SEVERITY_LABEL[f.severity]}</span>
              <span className="finding-title">L{f.line} {f.title}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tabs">
        <button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>コード</button>
        <button className={tab === "explain" ? "active" : ""} onClick={() => setTab("explain")}>AI 解説</button>
        <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>AI セキュリティ診断</button>
      </div>

      <div className="panel-body">
        {tab === "code" && (
          <div className="code" ref={codeRef}>
            {content === null ? (
              <div className="muted pad">読み込み中…</div>
            ) : (
              content.split("\n").map((line, i) => {
                const n = i + 1;
                const finding = findingLines.get(n);
                return (
                  <div
                    key={i}
                    data-line={n}
                    className={`code-line ${finding ? "flagged" : ""} ${focusLine === n ? "focus" : ""}`}
                    style={finding ? ({ "--flag": SEVERITY_COLOR[finding.severity] } as React.CSSProperties) : undefined}
                    title={finding ? `${finding.title}\n${finding.fix}` : undefined}
                  >
                    <span className="ln">{n}</span>
                    <span className="lc">{line || " "}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
        {tab !== "code" && (
          <div className="ai-pane">
            {!aiEnabled && <p className="notice">{AI_DISABLED_MESSAGE}</p>}
            {!ai.text && !ai.loading && (
              <div className="ai-start">
                <p className="muted">
                  {tab === "explain"
                    ? "このファイルの役割・処理の流れ・他ファイルとの関係を、AI が初心者向けに解説します。"
                    : "静的チェックの検出結果の真偽確認と、認証漏れ・入力検証などの追加チェックを AI が行い、修正方法を提案します。"}
                </p>
                <button className="primary" onClick={() => runAi(tab)} disabled={!aiEnabled}>
                  {tab === "explain" ? "AI で解説する" : "AI でセキュリティ診断する"}
                </button>
              </div>
            )}
            {ai.loading && !ai.text && <div className="muted pad">AI が考えています…</div>}
            {ai.text && <Markdown text={ai.text} paths={paths} onOpen={(p) => onOpen(p)} />}
            {ai.error && <p className="error">{ai.error}</p>}
            <div className="ai-actions">
              {ai.loading && <button onClick={ai.stop}>停止</button>}
              {!ai.loading && ai.text && <button onClick={() => runAi(tab)}>再生成</button>}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Relation({ title, items, onOpen }: { title: string; items: string[]; onOpen: (p: string) => void }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 6);
  return (
    <div className="relation">
      <div className="relation-title">{title}</div>
      {shown.map((p) => (
        <button key={p} className="link mono" onClick={() => onOpen(p)}>
          {p}
        </button>
      ))}
      {items.length > 6 && !all && (
        <button className="link muted" onClick={() => setAll(true)}>
          …ほか {items.length - 6} 件
        </button>
      )}
    </div>
  );
}
