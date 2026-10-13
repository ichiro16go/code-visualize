// ローカル専用の API サーバー (127.0.0.1 でのみ待ち受け)

import "./env.ts";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import type { ChatMessage } from "../shared/types.ts";
import { analyze } from "./analyzer/index.ts";
import { filterSources, type SourceFile } from "./analyzer/collect.ts";
import { aiStatus, chatMessages, describeAiError, explainPrompt, overviewPrompt, provider, securityPrompt, streamClaude } from "./ai.ts";
import { loadGitHub, loadLocal, parseGitHubUrl, SourceError } from "./sources.ts";
import { deleteAnalysis, getAnalysis, listHistory, saveAnalysis } from "./store.ts";

const PORT = Number(process.env.PORT ?? 5178);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err instanceof SourceError ? err.message : `サーバーエラー: ${err.message}` }, err instanceof SourceError ? 400 : 500);
});

app.get("/api/status", async (c) =>
  c.json({
    ai: await aiStatus(),
    hasGitHubToken: Boolean(process.env.GITHUB_TOKEN),
  }),
);

async function finishAnalysis(collected: Awaited<ReturnType<typeof loadLocal>>) {
  if (collected.result.files.length === 0) throw new SourceError("解析できるソースファイルが見つかりませんでした。");
  const analysis = analyze(collected.result, { name: collected.name, source: collected.source });
  const contents = Object.fromEntries(collected.result.files.map((f) => [f.path, f.content]));
  await saveAnalysis({ analysis, contents });
  return analysis;
}

app.post("/api/analyze", async (c) => {
  const { source } = await c.req.json<{ source?: string }>();
  if (!source?.trim()) throw new SourceError("GitHub の URL またはローカルフォルダのパスを入力してください。");
  const text = source.trim();
  // github.com の URL、またはローカルに存在しない "owner/repo" 形式は GitHub として扱う
  const isGitHub = /^(https?:\/\/)?(www\.)?github\.com\//.test(text) || (/^[\w.-]+\/[\w.-]+$/.test(text) && !existsSync(text));
  const gh = isGitHub ? parseGitHubUrl(text) : null;
  if (isGitHub && !gh) throw new SourceError("GitHub の URL を解釈できませんでした (例: https://github.com/owner/repo)");
  const loaded = gh ? await loadGitHub(gh) : await loadLocal(source);
  return c.json(await finishAnalysis(loaded));
});

app.post("/api/analyze/upload", async (c) => {
  const body = await c.req.json<{ name?: string; files?: Array<{ path: string; content: string }> }>();
  if (!body.files?.length) throw new SourceError("ファイルがありません。");
  // フォルダ選択ではパスの先頭にフォルダ名が付くので取り除く
  const first = body.files[0].path.split("/")[0];
  const sameRoot = body.files.every((f) => f.path.startsWith(`${first}/`));
  const sources: SourceFile[] = body.files.map((f) => ({
    path: sameRoot ? f.path.slice(first.length + 1) : f.path,
    content: f.content,
    size: Buffer.byteLength(f.content),
  }));
  const name = body.name || (sameRoot ? first : "upload");
  return c.json(await finishAnalysis({ result: filterSources(sources), name, source: `アップロード: ${name}` }));
});

app.get("/api/analyses", async (c) => c.json(await listHistory()));

app.get("/api/analyses/:id", async (c) => {
  const stored = await getAnalysis(c.req.param("id"));
  return stored ? c.json(stored.analysis) : c.json({ error: "見つかりません" }, 404);
});

app.delete("/api/analyses/:id", async (c) => {
  await deleteAnalysis(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/analyses/:id/file", async (c) => {
  const stored = await getAnalysis(c.req.param("id"));
  const p = c.req.query("path") ?? "";
  if (!stored || stored.contents[p] === undefined) return c.json({ error: "見つかりません" }, 404);
  return c.json({ path: p, content: stored.contents[p] });
});

app.post("/api/analyses/:id/ai/:kind", async (c) => {
  const stored = await getAnalysis(c.req.param("id"));
  if (!stored) return c.json({ error: "解析結果が見つかりません" }, 404);
  const kind = c.req.param("kind");
  const body = await c.req.json<{ path?: string; messages?: ChatMessage[] }>().catch(() => ({}) as { path?: string; messages?: ChatMessage[] });

  let messages;
  let effort: "medium" | "high" | undefined;
  if (kind === "overview") {
    messages = [{ role: "user" as const, content: overviewPrompt(stored) }];
    effort = "high";
  } else if (kind === "explain" && body.path && stored.contents[body.path] !== undefined) {
    messages = [{ role: "user" as const, content: explainPrompt(stored, body.path) }];
  } else if (kind === "security" && body.path && stored.contents[body.path] !== undefined) {
    messages = [{ role: "user" as const, content: securityPrompt(stored, body.path) }];
    effort = "high";
  } else if (kind === "chat" && body.messages?.length) {
    messages = chatMessages(stored, body.messages, body.path);
  } else {
    return c.json({ error: "不正なリクエストです" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      await streamClaude(stored.analysis, messages, { onText: (text) => stream.writeSSE({ event: "text", data: JSON.stringify(text) }) }, { effort, signal: abort.signal });
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error(e);
      await stream.writeSSE({ event: "error", data: JSON.stringify(describeAiError(e)) });
    }
  });
});

// ビルド済みのフロントエンドを配信 (npm run build 後)
if (existsSync("dist/index.html")) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, async (info) => {
  console.log(`CodeMap サーバー起動: http://${HOST}:${info.port}`);
  const ai = await aiStatus();
  const how = provider() === "subscription" ? "Claude Code 経由 (Claude のプランの利用枠)" : "Claude API (API キー)";
  if (ai.available) console.log(`  AI: ${how} / モデル: ${ai.model}`);
  else console.log(`  ※ AI 機能は無効です: ${ai.hint} (可視化・セキュリティチェックはそのまま使えます)`);
});
