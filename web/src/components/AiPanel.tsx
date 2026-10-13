// 右パネル: リポジトリ全体の AI 解説と、コードについての AI チャット

import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, ChatMessage } from "../../../shared/types.ts";
import { AI_DISABLED_MESSAGE } from "../api.ts";
import { useAiStream } from "../useAi.ts";
import { Markdown } from "./Markdown.tsx";

const overviewCache = new Map<string, string>();
const chatCache = new Map<string, ChatMessage[]>();

const SUGGESTIONS = [
  "このアプリはどんな仕組みで動いていますか？",
  "ログイン・認証はどこで処理されていますか？",
  "データはどこに保存されていますか？",
  "新しい画面を追加するにはどのファイルを触ればいい？",
  "公開前に直すべきセキュリティ上の問題は？",
];

export function AiPanel({
  analysis,
  tab,
  onTab,
  selected,
  onOpen,
  onClose,
  aiEnabled,
}: {
  analysis: Analysis;
  tab: "overview" | "chat";
  onTab: (t: "overview" | "chat") => void;
  selected: string | null;
  onOpen: (p: string) => void;
  onClose: () => void;
  aiEnabled: boolean;
}) {
  const paths = useMemo(() => new Set(analysis.files.map((f) => f.path)), [analysis]);
  return (
    <aside className="file-panel">
      <header className="panel-head">
        <div className="tabs inline">
          <button className={tab === "overview" ? "active" : ""} onClick={() => onTab("overview")}>AI 全体解説</button>
          <button className={tab === "chat" ? "active" : ""} onClick={() => onTab("chat")}>AI に質問</button>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="閉じる">✕</button>
      </header>
      {!aiEnabled && <p className="notice">{AI_DISABLED_MESSAGE}</p>}
      {tab === "overview" ? (
        <Overview analysis={analysis} paths={paths} onOpen={onOpen} aiEnabled={aiEnabled} />
      ) : (
        <Chat analysis={analysis} paths={paths} selected={selected} onOpen={onOpen} aiEnabled={aiEnabled} />
      )}
    </aside>
  );
}

function Overview({ analysis, paths, onOpen, aiEnabled }: { analysis: Analysis; paths: Set<string>; onOpen: (p: string) => void; aiEnabled: boolean }) {
  const ai = useAiStream(analysis.id);
  useEffect(() => {
    const cached = overviewCache.get(analysis.id);
    if (cached) ai.setText(cached);
  }, [analysis.id]);

  const run = async () => {
    const text = await ai.run("overview", {});
    if (text) overviewCache.set(analysis.id, text);
  };

  return (
    <div className="panel-body ai-pane">
      {!ai.text && !ai.loading && (
        <div className="ai-start">
          <p className="muted">README と主要ファイルを AI が読み、「何をするプロジェクトか」「全体の構造」「処理の流れ」「どこから読むべきか」をまとめます。</p>
          <button className="primary" onClick={run} disabled={!aiEnabled}>AI で全体を解説する</button>
        </div>
      )}
      {ai.loading && !ai.text && <div className="muted pad">AI がリポジトリを読んでいます…</div>}
      {ai.text && <Markdown text={ai.text} paths={paths} onOpen={onOpen} />}
      {ai.error && <p className="error">{ai.error}</p>}
      <div className="ai-actions">
        {ai.loading && <button onClick={ai.stop}>停止</button>}
        {!ai.loading && ai.text && <button onClick={run}>再生成</button>}
      </div>
    </div>
  );
}

function Chat({
  analysis,
  paths,
  selected,
  onOpen,
  aiEnabled,
}: {
  analysis: Analysis;
  paths: Set<string>;
  selected: string | null;
  onOpen: (p: string) => void;
  aiEnabled: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatCache.get(analysis.id) ?? []);
  const [input, setInput] = useState("");
  const [withFile, setWithFile] = useState(true);
  const ai = useAiStream(analysis.id);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatCache.set(analysis.id, messages);
  }, [analysis.id, messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, ai.text]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || ai.loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    const answer = await ai.run("chat", { messages: next, path: withFile && selected ? selected : undefined });
    if (answer) setMessages([...next, { role: "assistant", content: answer }]);
    else setMessages(messages);
    ai.setText("");
  };

  return (
    <div className="panel-body chat">
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="ai-start">
            <p className="muted">このリポジトリについて自由に質問できます。ファイル一覧と解析結果を踏まえて AI が答えます。</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={!aiEnabled}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "user" ? <p>{m.content}</p> : <Markdown text={m.content} paths={paths} onOpen={onOpen} />}
          </div>
        ))}
        {ai.loading && (
          <div className="msg assistant">
            {ai.text ? <Markdown text={ai.text} paths={paths} onOpen={onOpen} /> : <p className="muted">考え中…</p>}
          </div>
        )}
        {ai.error && <p className="error">{ai.error}</p>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        {selected && (
          <label className="small muted with-file">
            <input type="checkbox" checked={withFile} onChange={(e) => setWithFile(e.target.checked)} />
            選択中のファイル <span className="mono">{selected}</span> を添付
          </label>
        )}
        <div className="row">
          <textarea
            value={input}
            placeholder="質問を入力 (Enter で送信 / Shift+Enter で改行)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            disabled={!aiEnabled}
          />
          {ai.loading ? (
            <button type="button" onClick={ai.stop}>停止</button>
          ) : (
            <button type="submit" className="primary" disabled={!aiEnabled || !input.trim()}>送信</button>
          )}
        </div>
        {messages.length > 0 && (
          <button type="button" className="link muted small" onClick={() => setMessages([])}>会話をリセット</button>
        )}
      </form>
    </div>
  );
}
