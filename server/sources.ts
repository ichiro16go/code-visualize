// 解析対象の取得: GitHub リポジトリ (git clone) / ローカルフォルダ

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { collectFromDirectory, type CollectResult } from "./analyzer/collect.ts";

const execFileAsync = promisify(execFile);

export interface GitHubRef {
  owner: string;
  repo: string;
  branch?: string;
  subdir?: string;
}

/** "https://github.com/owner/repo/tree/main/src" や "owner/repo" を解釈する */
export function parseGitHubUrl(input: string): GitHubRef | null {
  const text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short && !text.startsWith(".") && !text.startsWith("/")) return { owner: short[1], repo: short[2] };
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/.exec(text);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], subdir: m[4] };
}

export class SourceError extends Error {}

export async function loadGitHub(ref: GitHubRef): Promise<{ result: CollectResult; name: string; source: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-"));
  const token = process.env.GITHUB_TOKEN;
  const url = `https://${token ? `x-access-token:${token}@` : ""}github.com/${ref.owner}/${ref.repo}.git`;
  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
  if (ref.branch) args.push("--branch", ref.branch);
  args.push(url, tmp);
  try {
    await execFileAsync("git", args, {
      timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).replaceAll(token ?? "\u0000", "***");
    throw new SourceError(
      `GitHub からの取得に失敗しました: ${msg.trim().split("\n").pop()}` +
        (token ? "" : "\n(非公開リポジトリの場合は環境変数 GITHUB_TOKEN を設定してください)"),
    );
  }
  try {
    const root = ref.subdir ? path.join(tmp, ref.subdir) : tmp;
    const result = await collectFromDirectory(root);
    const label = `${ref.owner}/${ref.repo}${ref.subdir ? `/${ref.subdir}` : ""}`;
    return { result, name: label, source: `https://github.com/${ref.owner}/${ref.repo}${ref.branch ? `/tree/${ref.branch}` : ""}${ref.subdir ? `/${ref.subdir}` : ""}` };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function loadLocal(input: string): Promise<{ result: CollectResult; name: string; source: string }> {
  const expanded = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  const abs = path.resolve(expanded);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new SourceError(`フォルダが見つかりません: ${abs}`);
  }
  if (!stat.isDirectory()) throw new SourceError(`フォルダではありません: ${abs}`);
  const result = await collectFromDirectory(abs);
  return { result, name: path.basename(abs), source: abs };
}
