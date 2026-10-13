// Claude API を使った解説・チャット機能

import Anthropic from "@anthropic-ai/sdk";
import type { Analysis, ChatMessage } from "../shared/types.ts";
import type { StoredAnalysis } from "./store.ts";

export const MODEL = process.env.CODEMAP_MODEL ?? "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT = (process.env.CODEMAP_EFFORT as Effort | undefined) ?? "medium";

// サーバー側フォールバック (安全性分類で拒否された場合に自動で別モデルが続行) に対応するモデル
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` のプロファイルを自動で読み込む
  client ??= new Anthropic();
  return client;
}

const PERSONA = `あなたはコードリーディングの優秀なガイドです。利用者はプログラミング初心者〜中級者で、AI が書いたコードや他人のリポジトリを理解しようとしています。
- 日本語で、専門用語には短い補足を添えて説明してください。
- ファイルパスは \`src/foo.ts\` のようにバッククォートで囲んでください。
- 推測で断定せず、コードから読み取れる事実と推測を区別してください。
- Markdown で、見出し・箇条書きを使って読みやすく構成してください。`;

const MAX_TREE_LINES = 700;

/** リポジトリの全体像をテキスト化 (システムプロンプト用) */
export function outline(a: Analysis): string {
  const s = a.summary;
  const langs = Object.entries(s.languages).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([l, n]) => `${l}: ${n}行`).join(", ");
  const tree = [...a.files]
    .sort((x, y) => x.path.localeCompare(y.path))
    .slice(0, MAX_TREE_LINES)
    .map((f) => `${f.path} (${f.lines}行, ${f.role}${f.readingOrder ? `, 読む順番#${f.readingOrder}` : ""}${f.imports.length ? `, imports: ${f.imports.slice(0, 8).join(" ")}` : ""})`)
    .join("\n");
  const findings = a.findings.slice(0, 40).map((f) => `- [${f.severity}] ${f.title} — ${f.file}:${f.line}`).join("\n");
  return `# リポジトリ: ${a.name}
ソース: ${a.source}
ファイル数: ${s.analyzedFiles} / 総行数: ${s.totalLines}
言語: ${langs}
エントリーポイント: ${s.entryPoints.join(", ") || "(不明)"}
外部パッケージ: ${s.externalPackages.slice(0, 40).join(", ") || "(なし)"}

## 機械的に推定した読む順番
${a.readingOrder.map((r) => `${r.order}. ${r.path} — ${r.reason}`).join("\n")}

## 静的セキュリティチェックの検出 (${a.findings.length}件)
${findings || "(なし)"}

## ファイル一覧${a.files.length > MAX_TREE_LINES ? ` (先頭 ${MAX_TREE_LINES} 件)` : ""}
${tree}`;
}

function fileBlock(path: string, content: string, limit: number): string {
  const body = content.length > limit ? `${content.slice(0, limit)}\n... (以下 ${content.length - limit} 文字省略)` : content;
  return `<file path="${path}">\n${body}\n</file>`;
}

function systemBlocks(a: Analysis): Anthropic.Beta.BetaTextBlockParam[] {
  // 同じ解析への複数回の質問で再利用されるよう、全体像をキャッシュする
  return [
    { type: "text", text: PERSONA },
    { type: "text", text: outline(a), cache_control: { type: "ephemeral" } },
  ];
}

export function overviewPrompt(stored: StoredAnalysis): string {
  const a = stored.analysis;
  let budget = 90_000;
  const parts: string[] = [];
  for (const step of a.readingOrder.slice(0, 12)) {
    const content = stored.contents[step.path];
    if (!content || budget <= 0) continue;
    const block = fileBlock(step.path, content, Math.min(12_000, budget));
    budget -= block.length;
    parts.push(block);
  }
  return `次の主要ファイルの内容も踏まえて、このリポジトリの解説を書いてください。

${parts.join("\n\n")}

## 出力してほしい内容
1. **ひとことで言うと**: 何をするプロジェクトか (2〜3文)
2. **技術スタック**: 使われている主な言語・フレームワーク・ライブラリと、その役割
3. **全体の構造**: 主要なフォルダ/ファイルの役割 (簡単な図や箇条書きで)
4. **処理の流れ**: 起動からユーザー操作までの代表的なデータの流れ
5. **おすすめの読む順番**: 機械的に推定した順番をベースに、最初に読むべき 5〜8 ファイルと、各ファイルで注目すべきポイント
6. **気をつける点**: セキュリティ検出や、分かりにくい箇所・改善余地があれば`;
}

export function explainPrompt(stored: StoredAnalysis, path: string): string {
  const a = stored.analysis;
  const f = a.files.find((x) => x.path === path);
  const content = stored.contents[path] ?? "";
  const neighbors = (f?.imports ?? []).slice(0, 5).map((p) => fileBlock(p, stored.contents[p] ?? "", 3_000)).join("\n\n");
  return `ファイル \`${path}\` を解説してください。

${fileBlock(path, content, 120_000)}

このファイルが import しているファイル: ${f?.imports.join(", ") || "なし"}
このファイルを import しているファイル: ${f?.importedBy.join(", ") || "なし"}
外部パッケージ: ${f?.externalImports.join(", ") || "なし"}

参考: import 先の冒頭部分
${neighbors || "(なし)"}

## 出力してほしい内容
1. **このファイルの役割** (ひとことで)
2. **中身の説明**: 主な関数・クラス・コンポーネントごとに、何をしているか
3. **処理の流れ**: 呼び出される順に
4. **他のファイルとの関係**: どこから使われ、何を使っているか
5. **読むときのポイント・注意点**: 初心者がつまずきやすい書き方や、バグ・セキュリティ上気になる点があれば`;
}

export function securityPrompt(stored: StoredAnalysis, path: string): string {
  const a = stored.analysis;
  const content = stored.contents[path] ?? "";
  const static_ = a.findings.filter((f) => f.file === path).map((f) => `- L${f.line} [${f.severity}] ${f.title}: \`${f.snippet}\``).join("\n");
  return `ファイル \`${path}\` のセキュリティレビューをしてください。

${fileBlock(path, content, 120_000)}

## 静的チェックの検出結果 (誤検知の可能性あり)
${static_ || "(なし)"}

## 出力してほしい内容
1. **総合評価**: 問題なし / 要注意 / 危険 のいずれかと理由
2. **検出結果の確認**: 静的チェックの各検出が本当に問題か (誤検知ならその理由)
3. **追加で見つかった問題**: 認証・認可の抜け、入力値検証、秘密情報の扱い、インジェクション、XSS、CSRF、権限設定など
4. **修正方法**: 問題ごとに、修正後のコード例を示して具体的に

非エンジニアにも危険度が伝わるよう、「何が起こりうるか」を具体的に書いてください。`;
}

export interface StreamHandlers {
  onText: (text: string) => Promise<void> | void;
}

export async function streamClaude(
  analysis: Analysis,
  messages: Anthropic.Beta.BetaMessageParam[],
  handlers: StreamHandlers,
  options: { effort?: Effort; signal?: AbortSignal } = {},
): Promise<void> {
  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model: MODEL,
    max_tokens: 64000,
    system: systemBlocks(analysis),
    messages,
    output_config: { effort: options.effort ?? EFFORT },
    stream: true,
  };
  if (FALLBACK_MODELS.has(MODEL)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const stream = getClient().beta.messages.stream(params, { signal: options.signal });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      await handlers.onText(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    await handlers.onText("\n\n> この内容には回答できませんでした (安全性の判定により停止しました)。質問の仕方を変えて試してください。");
  } else if (final.stop_reason === "max_tokens") {
    await handlers.onText("\n\n> (出力が長すぎるため途中で終了しました)");
  }
}

export function chatMessages(stored: StoredAnalysis, history: ChatMessage[], focusPath?: string): Anthropic.Beta.BetaMessageParam[] {
  const msgs: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const last = msgs[msgs.length - 1];
  if (focusPath && last?.role === "user" && stored.contents[focusPath] !== undefined) {
    last.content = `(いま画面で選択中のファイル)\n${fileBlock(focusPath, stored.contents[focusPath], 60_000)}\n\n${String(last.content)}`;
  }
  return msgs;
}

export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return "Claude API の認証に失敗しました。環境変数 ANTHROPIC_API_KEY を設定してからサーバーを再起動してください。";
  }
  if (e instanceof Anthropic.PermissionDeniedError) return "この API キーではこのモデルを利用できません。CODEMAP_MODEL を変更してください。";
  if (e instanceof Anthropic.NotFoundError) return `モデル ${MODEL} が見つかりません。CODEMAP_MODEL を確認してください。`;
  if (e instanceof Anthropic.RateLimitError) return "API の利用上限に達しました。しばらく待ってから再試行してください。";
  if (e instanceof Anthropic.BadRequestError) return `リクエストが不正です: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Claude API エラー (${e.status ?? "?"}): ${e.message}`;
  if (e instanceof Error && /api key|apiKey|authentication|credentials/i.test(e.message)) {
    return "Claude API の認証情報が見つかりません。環境変数 ANTHROPIC_API_KEY を設定してからサーバーを再起動してください。";
  }
  return `AI 機能でエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
}
