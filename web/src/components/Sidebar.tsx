// 左サイドバー: 概要と、ビューごとのリスト (読む順番 / セキュリティ / 複雑度ランキング)

import { useMemo, useState } from "react";
import type { Analysis, Severity } from "../../../shared/types.ts";
import { ROLE_COLOR, ROLE_LABEL, SEVERITY_COLOR, SEVERITY_LABEL, type ViewMode } from "../graph.ts";

const LANG_COLORS = ["#4f6bed", "#12a594", "#f76b15", "#d6409f", "#8e4ec6", "#e5484d", "#3e9b4f", "#ffb224", "#8e8c99"];

export function Sidebar({
  analysis,
  mode,
  selected,
  onOpen,
}: {
  analysis: Analysis;
  mode: ViewMode;
  selected: string | null;
  onOpen: (path: string, line?: number) => void;
}) {
  return (
    <aside className="sidebar">
      <Summary analysis={analysis} onOpen={onOpen} />
      {mode === "reading" && <ReadingList analysis={analysis} selected={selected} onOpen={onOpen} />}
      {mode === "security" && <FindingList analysis={analysis} onOpen={onOpen} />}
      {mode === "complexity" && <ComplexityList analysis={analysis} onOpen={onOpen} />}
      {(mode === "structure" || mode === "dependency") && <Legend />}
    </aside>
  );
}

function Summary({ analysis, onOpen }: { analysis: Analysis; onOpen: (p: string) => void }) {
  const s = analysis.summary;
  const langs = Object.entries(s.languages).sort((a, b) => b[1] - a[1]);
  const total = langs.reduce((n, [, v]) => n + v, 0) || 1;
  const top = langs.slice(0, 6);
  const rest = langs.slice(6).reduce((n, [, v]) => n + v, 0);
  if (rest) top.push(["その他", rest]);
  const sevs: Severity[] = ["critical", "high", "medium", "low"];

  return (
    <section className="card">
      <div className="stats">
        <div><strong>{s.analyzedFiles.toLocaleString()}</strong><span>ファイル</span></div>
        <div><strong>{s.totalLines.toLocaleString()}</strong><span>行</span></div>
        <div><strong>{analysis.findings.length}</strong><span>検出</span></div>
      </div>
      <div className="lang-bar">
        {top.map(([l, v], i) => (
          <span key={l} style={{ width: `${(v / total) * 100}%`, background: LANG_COLORS[i % LANG_COLORS.length] }} title={`${l}: ${v} 行`} />
        ))}
      </div>
      <div className="lang-legend">
        {top.map(([l, v], i) => (
          <span key={l}>
            <i style={{ background: LANG_COLORS[i % LANG_COLORS.length] }} />
            {l} {Math.round((v / total) * 100)}%
          </span>
        ))}
      </div>
      <div className="sev-row">
        {sevs.map((sv) => (
          <span key={sv} className="sev-count" style={{ "--c": SEVERITY_COLOR[sv] } as React.CSSProperties}>
            {SEVERITY_LABEL[sv]} {s.findingsBySeverity[sv]}
          </span>
        ))}
      </div>
      {s.entryPoints.length > 0 && (
        <div className="kv">
          <div className="kv-title">エントリーポイント</div>
          {s.entryPoints.map((e) => (
            <button key={e} className="link mono" onClick={() => onOpen(e)}>{e}</button>
          ))}
        </div>
      )}
      {s.externalPackages.length > 0 && (
        <div className="kv">
          <div className="kv-title">主な外部パッケージ</div>
          <div className="pkg-list">
            {s.externalPackages.slice(0, 18).map((p) => <span key={p} className="tag">{p}</span>)}
          </div>
        </div>
      )}
      {(s.truncated || s.skipped > 0) && (
        <p className="muted small">
          {s.skipped} 件のファイル (バイナリ・大きすぎるファイル・依存ライブラリ等) を除外しました{s.truncated ? "。上限に達したため一部のみ解析しています" : ""}。
        </p>
      )}
    </section>
  );
}

function ReadingList({ analysis, selected, onOpen }: { analysis: Analysis; selected: string | null; onOpen: (p: string) => void }) {
  return (
    <section className="card list">
      <h3>おすすめの読む順番</h3>
      <p className="muted small">README → 設定 → エントリーポイント → そこから読み込まれるファイル の順に、依存関係をたどって並べています。</p>
      <ol className="steps">
        {analysis.readingOrder.map((s) => (
          <li key={s.path} className={selected === s.path ? "active" : ""}>
            <button onClick={() => onOpen(s.path)}>
              <span className="step-no">{s.order}</span>
              <span className="step-body">
                <span className="mono">{s.path}</span>
                <span className="muted small">{s.reason}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FindingList({ analysis, onOpen }: { analysis: Analysis; onOpen: (p: string, line?: number) => void }) {
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [openRule, setOpenRule] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, typeof analysis.findings>();
    for (const f of analysis.findings) {
      if (filter !== "all" && f.severity !== filter) continue;
      m.set(f.ruleId, [...(m.get(f.ruleId) ?? []), f]);
    }
    return [...m.entries()];
  }, [analysis, filter]);

  return (
    <section className="card list">
      <h3>セキュリティチェック</h3>
      <div className="chips">
        {(["all", "critical", "high", "medium", "low"] as const).map((s) => (
          <button key={s} className={`chip ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>
            {s === "all" ? "すべて" : SEVERITY_LABEL[s]}
          </button>
        ))}
      </div>
      {groups.length === 0 && <p className="muted small">該当する検出はありません 🎉 (静的チェックで見つからなくても安全とは限りません。気になるファイルは AI セキュリティ診断も試してください)</p>}
      {groups.map(([rule, items]) => {
        const first = items[0];
        const open = openRule === rule;
        return (
          <div key={rule} className="rule">
            <button className="rule-head" onClick={() => setOpenRule(open ? null : rule)}>
              <span className="sev" style={{ background: SEVERITY_COLOR[first.severity] }}>{SEVERITY_LABEL[first.severity]}</span>
              <span className="rule-title">{first.title}</span>
              <span className="count">{items.length}</span>
            </button>
            {open && (
              <div className="rule-body">
                <p>{first.description}</p>
                <p className="fix"><strong>対策:</strong> {first.fix}</p>
                {items.map((f, i) => (
                  <button key={i} className="finding-loc" onClick={() => onOpen(f.file, f.line)}>
                    <span className="mono">{f.file}:{f.line}</span>
                    <code>{f.snippet}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ComplexityList({ analysis, onOpen }: { analysis: Analysis; onOpen: (p: string) => void }) {
  const top = [...analysis.files].filter((f) => f.complexity > 0).sort((a, b) => b.complexity - a.complexity).slice(0, 15);
  return (
    <section className="card list">
      <h3>複雑なファイル TOP 15</h3>
      <p className="muted small">複雑度は if / for / && などの分岐の数の目安です。大きく複雑なファイルほど、読むのが難しくバグも入りやすくなります。</p>
      {top.map((f) => (
        <button key={f.path} className="rank-row" onClick={() => onOpen(f.path)}>
          <span className="mono">{f.path}</span>
          <span className="muted small">{f.lines} 行 · 複雑度 {f.complexity}</span>
        </button>
      ))}
    </section>
  );
}

function Legend() {
  return (
    <section className="card">
      <h3>色の意味 (ファイルの役割)</h3>
      <div className="legend">
        {(Object.keys(ROLE_LABEL) as Array<keyof typeof ROLE_LABEL>).map((r) => (
          <span key={r}>
            <i style={{ background: ROLE_COLOR[r] }} />
            {ROLE_LABEL[r]}
          </span>
        ))}
      </div>
      <p className="muted small">#数字 は読む順番、←数字 はそのファイルを読み込んでいるファイル数です。ノードをクリックすると詳細を表示します。</p>
    </section>
  );
}
