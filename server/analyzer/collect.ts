// ディレクトリやアップロードされたファイル群から解析対象のソースファイルを集める

import { promises as fs } from "node:fs";
import path from "node:path";
import { detectLanguage } from "../../shared/languages.ts";

export interface SourceFile {
  path: string;
  content: string;
  size: number;
}

export interface CollectResult {
  files: SourceFile[];
  skipped: number;
  truncated: boolean;
}

export const LIMITS = {
  maxFiles: 4000,
  maxFileBytes: 400 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
};

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".vscode",
  ".gradle",
  "Pods",
  "DerivedData",
]);

const IGNORED_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/;

/** パスの一部に除外ディレクトリを含むかどうか */
export function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p)) || IGNORED_FILES.test(relPath);
}

function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\u0000");
}

/** 収集したファイル候補を制限付きで絞り込む */
export function filterSources(candidates: SourceFile[]): CollectResult {
  const files: SourceFile[] = [];
  let skipped = 0;
  let total = 0;
  let truncated = false;
  const sorted = [...candidates].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const rel = f.path.replace(/^\.?\/+/, "");
    if (isIgnoredPath(rel) || !detectLanguage(rel) || f.size > LIMITS.maxFileBytes || looksBinary(f.content)) {
      skipped++;
      continue;
    }
    if (files.length >= LIMITS.maxFiles || total + f.size > LIMITS.maxTotalBytes) {
      truncated = true;
      skipped++;
      continue;
    }
    total += f.size;
    files.push({ ...f, path: rel });
  }
  return { files, skipped, truncated };
}

/** ローカルディレクトリを再帰的に読み込む */
export async function collectFromDirectory(root: string): Promise<CollectResult> {
  const candidates: SourceFile[] = [];
  let skipped = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if (isIgnoredPath(rel) || !detectLanguage(rel)) {
          skipped++;
          continue;
        }
        const stat = await fs.stat(abs);
        if (stat.size > LIMITS.maxFileBytes) {
          skipped++;
          continue;
        }
        if (candidates.length > LIMITS.maxFiles * 2) {
          skipped++;
          continue;
        }
        const content = await fs.readFile(abs, "utf8");
        candidates.push({ path: rel, content, size: stat.size });
      }
    }
  }

  await walk(root);
  const result = filterSources(candidates);
  return { ...result, skipped: result.skipped + skipped };
}
