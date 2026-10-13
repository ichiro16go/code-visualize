// 最初の画面: GitHub URL / ローカルパス入力、フォルダのアップロード、履歴

import { useEffect, useRef, useState } from "react";
import type { Analysis } from "../../../shared/types.ts";
import { api, filesFromDrop, readUploadedFiles, type HistoryItem, type Status } from "../api.ts";

export function Home({ status, onLoaded }: { status: Status | null; onLoaded: (a: Analysis) => void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.history().then(setHistory, () => setHistory([]));
  }, []);

  const wrap = async (label: string, fn: () => Promise<Analysis>) => {
    setBusy(label);
    setError(null);
    try {
      onLoaded(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uploadFiles = (list: Iterable<File & { relPath?: string }>, name?: string) =>
    wrap("ファイルを読み込んでいます…", async () => {
      const files = await readUploadedFiles(list);
      if (!files.length) throw new Error("解析できるソースファイルが見つかりませんでした。");
      return api.upload(name ?? "", files);
    });

  return (
    <div
      className={`home ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const files = await filesFromDrop(e.dataTransfer.items);
        if (files.length) void uploadFiles(files);
      }}
    >
      <div className="hero">
        <div className="logo">
          <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <circle cx="9" cy="10" r="3" fill="white" />
            <circle cx="23" cy="10" r="3" fill="white" />
            <circle cx="16" cy="23" r="3" fill="white" />
            <path d="M9 10L16 23L23 10" stroke="white" strokeWidth="2" fill="none" />
          </svg>
          <h1>CodeMap</h1>
        </div>
        <p className="tagline">コードの構造を地図のように可視化し、どこから読めばいいかを AI が案内します。<br />セキュリティの問題もまとめてチェック。</p>

        <form
          className="source-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim()) void wrap("解析しています… (大きなリポジトリは数十秒かかります)", () => api.analyze(source));
          }}
        >
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repo  または  ~/projects/my-app"
            disabled={!!busy}
            autoFocus
          />
          <button className="primary" disabled={!!busy || !source.trim()}>可視化する</button>
        </form>

        <div className="or">
          <span>または</span>
          <button className="ghost" onClick={() => folderRef.current?.click()} disabled={!!busy}>フォルダを選択</button>
          <span className="muted small">(ここにフォルダをドラッグ&ドロップしても OK)</span>
          <input
            ref={folderRef}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
        </div>

        {busy && <div className="busy"><span className="spinner" />{busy}</div>}
        {error && <pre className="error">{error}</pre>}

        <div className="status-row">
          <span className={`pill ${status?.ai.available ? "ok" : "warn"}`} title={status?.ai.hint}>
            {!status
              ? "AI: 確認中…"
              : status.ai.available
                ? `AI: 有効 (${status.ai.provider === "subscription" ? "Claude のプラン" : "API キー"} / ${status.ai.model})`
                : `AI: 無効 — ${status.ai.hint ?? "設定を確認してください"} (可視化とセキュリティチェックは使えます)`}
          </span>
          {status && !status.hasGitHubToken && <span className="pill">非公開リポジトリには GITHUB_TOKEN が必要</span>}
        </div>
      </div>

      {history.length > 0 && (
        <section className="history">
          <h2>最近の解析</h2>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button className="history-item" onClick={() => wrap("読み込んでいます…", () => api.load(h.id))}>
                  <strong>{h.name}</strong>
                  <span className="muted small">{h.source}</span>
                  <span className="muted small">
                    {new Date(h.createdAt).toLocaleString("ja-JP")} · {h.files} ファイル · 検出 {h.findings} 件
                  </span>
                </button>
                <button
                  className="icon-btn"
                  aria-label="削除"
                  title="履歴から削除"
                  onClick={async () => {
                    await api.remove(h.id);
                    setHistory((xs) => xs.filter((x) => x.id !== h.id));
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="features">
        <div><strong>5 つのビュー</strong><span>フォルダ構造・依存関係・読む順番・セキュリティ・複雑度マップ</span></div>
        <div><strong>AI 解説</strong><span>全体像、ファイルごとの役割、自由な質問に日本語で回答</span></div>
        <div><strong>セキュリティチェック</strong><span>API キーの直書き・SQL インジェクション・XSS など 21 種類のルール + AI 診断</span></div>
        <div><strong>ローカル完結</strong><span>コードはあなたの PC 内で解析。AI 機能を使うときだけ Claude に送信 (Pro / Max プランでも API キーでも OK)</span></div>
      </section>
    </div>
  );
}
