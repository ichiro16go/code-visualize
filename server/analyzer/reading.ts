// エントリーポイントの推定と「どこから読むべきか」の順番づけ

import type { FileInfo, ReadingStep } from "../../shared/types.ts";
import type { SourceFile } from "./collect.ts";
import { AUX_PATH, CODE_LANGUAGES } from "../../shared/languages.ts";

const ENTRY_NAME_PATTERNS: Array<[RegExp, number]> = [
  [/^(src\/)?main\.(tsx?|jsx?|py|go|rs)$/, 10],
  [/^src\/(index|main)\.(tsx?|jsx?)$/, 10],
  [/^(src\/)?app\/(layout|page)\.(tsx?|jsx?)$/, 9],
  [/^(src\/)?pages\/_app\.(tsx?|jsx?)$/, 9],
  [/^(src\/)?pages\/index\.(tsx?|jsx?|vue|astro)$/, 7],
  [/^(src\/)?(server|app|index)\.(tsx?|jsx?|mjs|cjs)$/, 8],
  [/^(src\/)?App\.(tsx?|jsx?|vue|svelte)$/, 6],
  [/^(manage|app|main|wsgi|asgi|run|server)\.py$/, 9],
  [/(^|\/)__main__\.py$/, 8],
  [/^cmd\/[^/]+\/main\.go$/, 9],
  [/^main\.go$/, 10],
  [/^src\/(main|lib)\.rs$/, 10],
  [/^(config\.ru|app\.rb|bin\/rails)$/, 7],
  [/^(public\/)?index\.php$/, 7],
  [/^index\.html$/, 5],
];

export function detectEntryPoints(files: FileInfo[], sources: Map<string, SourceFile>): string[] {
  const scores = new Map<string, number>();
  const bump = (p: string, n: number) => {
    if (sources.has(p)) scores.set(p, (scores.get(p) ?? 0) + n);
  };

  for (const f of files) {
    for (const [re, score] of ENTRY_NAME_PATTERNS) if (re.test(f.path)) bump(f.path, score);
    const content = sources.get(f.path)?.content ?? "";
    if (f.language === "Python" && /if\s+__name__\s*==\s*["']__main__["']/.test(content)) bump(f.path, 4);
    if (f.language === "Go" && /^package\s+main\b/m.test(content) && /\bfunc\s+main\s*\(/.test(content)) bump(f.path, 6);
    if (/public\s+static\s+void\s+main\s*\(/.test(content)) bump(f.path, 6);
    if (f.role === "test") scores.delete(f.path);
  }

  // package.json の main / bin / scripts から参照されるファイル
  for (const [path, src] of sources) {
    if (!path.endsWith("package.json")) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    try {
      const pkg = JSON.parse(src.content);
      const refs: string[] = [];
      if (typeof pkg.main === "string") refs.push(pkg.main);
      if (typeof pkg.module === "string") refs.push(pkg.module);
      if (typeof pkg.bin === "string") refs.push(pkg.bin);
      if (pkg.bin && typeof pkg.bin === "object") refs.push(...Object.values<string>(pkg.bin));
      for (const cmd of Object.values<string>(pkg.scripts ?? {})) {
        for (const m of String(cmd).matchAll(/(?:node|tsx|ts-node|bun|deno run|nodemon)\s+(?:[-\w=]+\s+)*([\w./-]+\.[cm]?[jt]sx?)/g)) refs.push(m[1]);
      }
      for (const ref of refs) {
        const p = (dir + ref.replace(/^\.\//, "")).replace(/\/+/g, "/");
        bump(p, 8);
        // dist/index.js → src/index.ts のようにソースを推定
        bump(p.replace(/^(.*\/)?(dist|build|lib|out)\//, "$1src/").replace(/\.js$/, ".ts"), 6);
      }
    } catch {
      // 無視
    }
  }

  let entries = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([p]) => p);

  // 名前で見つからない場合は「どこからも import されず、多くを import している」ファイルを使う
  if (entries.length === 0) {
    entries = files
      .filter((f) => CODE_LANGUAGES.has(f.language) && f.role !== "test" && f.importedBy.length === 0 && f.imports.length > 0)
      .sort((a, b) => b.imports.length - a.imports.length)
      .slice(0, 3)
      .map((f) => f.path);
  }
  return entries.slice(0, 6);
}

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts"];

const MAX_STEPS = 30;

export function computeReadingOrder(files: FileInfo[], entryPoints: string[]): ReadingStep[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const steps: ReadingStep[] = [];
  const seen = new Set<string>();
  const add = (path: string, reason: string) => {
    if (seen.has(path) || !byPath.has(path) || steps.length >= MAX_STEPS) return;
    seen.add(path);
    steps.push({ order: steps.length + 1, path, reason });
  };

  const readme = files.find((f) => /^readme(\.\w+)?$/i.test(f.path));
  if (readme) add(readme.path, "プロジェクトの概要。何をするアプリなのかを最初に把握します。");
  for (const m of MANIFESTS) {
    if (byPath.has(m)) {
      add(m, "使っているライブラリと起動コマンドの定義。技術スタックが分かります。");
      break;
    }
  }

  // 本体のコードがあるならサンプル等 (examples/ など) は後回しにする
  const hasMain = files.some((f) => CODE_LANGUAGES.has(f.language) && !AUX_PATH.test(f.path) && f.role !== "test");
  const readable = (f: FileInfo | undefined) =>
    !!f && f.role !== "test" && f.role !== "style" && CODE_LANGUAGES.has(f.language) && !(hasMain && AUX_PATH.test(f.path));

  // エントリーポイントから依存先を幅優先でたどる。各階層では「多くのファイルから使われる中核ファイル」を優先
  const queue: Array<{ path: string; depth: number; parent: string | null }> = entryPoints.map((p) => ({ path: p, depth: 0, parent: null }));
  const enqueued = new Set(entryPoints);
  while (queue.length && steps.length < MAX_STEPS) {
    const { path, depth, parent } = queue.shift()!;
    const f = byPath.get(path);
    if (!f) continue;
    if (depth === 0) add(path, "エントリーポイント (アプリの起動地点)。ここから処理が始まります。");
    else if (readable(f)) {
      const users = f.importedBy.length;
      add(path, `${parent} から読み込まれています${users > 1 ? ` (${users} ファイルが利用)` : ""}。${roleHint(f)}`);
    }
    if (depth >= 4) continue;
    const children = f.imports
      .map((p) => byPath.get(p))
      .filter((c): c is FileInfo => readable(c) && !enqueued.has(c!.path))
      .sort((a, b) => b.importedBy.length - a.importedBy.length || b.lines - a.lines);
    for (const c of children) {
      enqueued.add(c.path);
      queue.push({ path: c.path, depth: depth + 1, parent: path });
    }
  }

  // Next.js の route.ts などフレームワークが直接呼ぶ API の入り口は import されないので別途追加する
  const routes = files.filter((f) => readable(f) && !seen.has(f.path) && f.role === "route" && f.importedBy.length === 0).slice(0, 6);
  for (const r of routes) add(r.path, "URL / API の入り口 (ルーティング)。リクエストを受けたときの処理がここから始まります。");

  // 辿れなかったが多くのファイルから参照されている中核ファイルを補う
  const hubs = files
    .filter((f) => readable(f) && !seen.has(f.path) && f.importedBy.length >= 2)
    .sort((a, b) => b.importedBy.length - a.importedBy.length)
    .slice(0, 8);
  for (const h of hubs) add(h.path, `${h.importedBy.length} ファイルから参照される中核モジュール。${roleHint(h)}`);

  // それでも少なければ大きいファイルを補う
  if (steps.length < 5) {
    const big = files.filter((f) => readable(f) && !seen.has(f.path)).sort((a, b) => b.lines - a.lines).slice(0, 5 - steps.length);
    for (const b of big) add(b.path, `規模の大きいファイル (${b.lines} 行)。主要なロジックが含まれている可能性があります。`);
  }
  return steps;
}

function roleHint(f: FileInfo): string {
  switch (f.role) {
    case "component":
      return "画面の部品 (UI コンポーネント) です。";
    case "route":
      return "URL やAPIの入り口 (ルーティング) を定義しています。";
    case "model":
      return "データの形 (型・スキーマ・DB) を定義しています。";
    case "util":
      return "共通で使われる便利関数です。";
    case "config":
      return "設定ファイルです。";
    default:
      return "";
  }
}
