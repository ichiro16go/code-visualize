import type { Analysis, ChatMessage } from "../../shared/types.ts";
import { detectLanguage } from "../../shared/languages.ts";

export interface Status {
  model: string;
  hasApiKey: boolean;
  hasGitHubToken: boolean;
}

export interface HistoryItem {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  files: number;
  findings: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => request<Status>("/api/status"),
  history: () => request<HistoryItem[]>("/api/analyses"),
  load: (id: string) => request<Analysis>(`/api/analyses/${id}`),
  remove: (id: string) => request<{ ok: boolean }>(`/api/analyses/${id}`, { method: "DELETE" }),
  analyze: (source: string) => request<Analysis>("/api/analyze", { method: "POST", body: JSON.stringify({ source }) }),
  upload: (name: string, files: Array<{ path: string; content: string }>) =>
    request<Analysis>("/api/analyze/upload", { method: "POST", body: JSON.stringify({ name, files }) }),
  file: (id: string, path: string) => request<{ path: string; content: string }>(`/api/analyses/${id}/file?path=${encodeURIComponent(path)}`),
};

const IGNORED = /(^|\/)(\.git|node_modules|vendor|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|target|__pycache__|\.venv|venv|\.idea|\.vscode)\//;
const MAX_FILE = 400 * 1024;

/** フォルダ選択 / ドラッグ&ドロップされたファイルを読み込む (不要なものはブラウザ側で除外) */
export async function readUploadedFiles(list: Iterable<File & { webkitRelativePath?: string; relPath?: string }>) {
  const files: Array<{ path: string; content: string }> = [];
  for (const f of list) {
    const path = f.relPath || f.webkitRelativePath || f.name;
    if (IGNORED.test(path) || f.size > MAX_FILE || !detectLanguage(path)) continue;
    files.push({ path, content: await f.text() });
    if (files.length >= 4000) break;
  }
  return files;
}

/** ドラッグ&ドロップされたフォルダを再帰的に展開する */
export async function filesFromDrop(items: DataTransferItemList): Promise<Array<File & { relPath: string }>> {
  const out: Array<File & { relPath: string }> = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (IGNORED.test(`${path}/`)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(Object.assign(file, { relPath: path }));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path);
      }
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  for (const e of entries) await walk(e, "");
  return out;
}

export type AiKind = "overview" | "explain" | "security" | "chat";

/** AI 応答を Server-Sent Events で受け取る */
export async function streamAi(
  id: string,
  kind: AiKind,
  body: { path?: string; messages?: ChatMessage[] },
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/analyses/${id}/ai/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "text") onText(JSON.parse(data));
      else if (event === "error") throw new Error(JSON.parse(data));
      else if (event === "done") return;
    }
  }
}
