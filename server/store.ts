// 解析結果の保存 (メモリ + ローカルディスク)。個人利用なのでファイル保存で十分

import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Analysis } from "../shared/types.ts";

export interface StoredAnalysis {
  analysis: Analysis;
  contents: Record<string, string>;
}

export interface HistoryItem {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  files: number;
  findings: number;
}

const DATA_DIR = path.resolve(process.env.CODEMAP_DATA_DIR ?? ".codemap-data");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const MAX_HISTORY = 30;
const MAX_CACHE = 4;
const cache = new Map<string, StoredAnalysis>();

function fileFor(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error("invalid id");
  return path.join(DATA_DIR, `${id}.json.gz`);
}

function remember(stored: StoredAnalysis): void {
  cache.delete(stored.analysis.id);
  cache.set(stored.analysis.id, stored);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

export async function listHistory(): Promise<HistoryItem[]> {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, "utf8")) as HistoryItem[];
  } catch {
    return [];
  }
}

async function writeHistory(items: HistoryItem[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(items, null, 2));
}

export async function saveAnalysis(stored: StoredAnalysis): Promise<void> {
  remember(stored);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(stored.analysis.id), gzipSync(JSON.stringify(stored)));
  const a = stored.analysis;
  const items = [
    { id: a.id, name: a.name, source: a.source, createdAt: a.createdAt, files: a.files.length, findings: a.findings.length },
    ...(await listHistory()).filter((i) => i.id !== a.id),
  ];
  for (const old of items.slice(MAX_HISTORY)) await fs.rm(fileFor(old.id), { force: true });
  await writeHistory(items.slice(0, MAX_HISTORY));
}

export async function getAnalysis(id: string): Promise<StoredAnalysis | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const raw = await fs.readFile(fileFor(id));
    const stored = JSON.parse(gunzipSync(raw).toString("utf8")) as StoredAnalysis;
    remember(stored);
    return stored;
  } catch {
    return null;
  }
}

export async function deleteAnalysis(id: string): Promise<void> {
  cache.delete(id);
  await fs.rm(fileFor(id), { force: true });
  await writeHistory((await listHistory()).filter((i) => i.id !== id));
}
