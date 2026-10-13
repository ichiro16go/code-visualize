// 解析のエントリーポイント: ソースファイル群から Analysis を組み立てる

import { randomUUID } from "node:crypto";
import type { Analysis, FileInfo, Severity } from "../../shared/types.ts";
import type { CollectResult, SourceFile } from "./collect.ts";
import { AUX_PATH, detectLanguage } from "../../shared/languages.ts";
import { RepoIndex, resolveImports } from "./imports.ts";
import { classifyRole, computeMetrics } from "./metrics.ts";
import { computeReadingOrder, detectEntryPoints } from "./reading.ts";
import { scanFile } from "./security.ts";

export function analyze(collected: CollectResult, meta: { name: string; source: string }): Analysis {
  const { files: sources } = collected;
  const index = new RepoIndex(sources);
  const sourceMap = new Map<string, SourceFile>(sources.map((s) => [s.path, s]));

  const files: FileInfo[] = sources.map((src) => {
    const language = detectLanguage(src.path) ?? "Text";
    const metrics = computeMetrics(src.content, language);
    const imports = resolveImports(src, language, index);
    return {
      path: src.path,
      language,
      size: src.size,
      ...metrics,
      role: classifyRole(src.path, language, src.content),
      imports: imports.internal,
      importedBy: [],
      externalImports: imports.external,
      readingOrder: null,
      readingReason: null,
    };
  });

  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) {
    for (const target of f.imports) byPath.get(target)?.importedBy.push(f.path);
  }

  const entryPoints = detectEntryPoints(files, sourceMap);
  for (const e of entryPoints) {
    const f = byPath.get(e);
    if (f && f.role !== "test") f.role = "entry";
  }

  const readingOrder = computeReadingOrder(files, entryPoints);
  for (const step of readingOrder) {
    const f = byPath.get(step.path);
    if (f) {
      f.readingOrder = step.order;
      f.readingReason = step.reason;
    }
  }

  const findings = sources.flatMap((src) => scanFile(src, byPath.get(src.path)?.language ?? "Text"));
  const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

  const languages: Record<string, number> = {};
  for (const f of files) languages[f.language] = (languages[f.language] ?? 0) + f.lines;

  const externalCounts = new Map<string, number>();
  // テストやサンプルからの利用は重みを小さくして、本体で使うパッケージを上位にする
  for (const f of files) {
    const weight = f.role === "test" || AUX_PATH.test(f.path) ? 0.01 : 1;
    for (const e of f.externalImports) externalCounts.set(e, (externalCounts.get(e) ?? 0) + weight);
  }

  const findingsBySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) findingsBySeverity[f.severity]++;

  return {
    id: randomUUID(),
    name: meta.name,
    source: meta.source,
    createdAt: new Date().toISOString(),
    files,
    readingOrder,
    findings,
    summary: {
      totalFiles: files.length + collected.skipped,
      analyzedFiles: files.length,
      totalLines: files.reduce((n, f) => n + f.lines, 0),
      languages,
      entryPoints,
      externalPackages: [...externalCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
      findingsBySeverity,
      skipped: collected.skipped,
      truncated: collected.truncated,
    },
  };
}
