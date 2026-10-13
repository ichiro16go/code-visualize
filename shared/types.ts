// サーバーとフロントエンドで共有するデータ型

export type Severity = "critical" | "high" | "medium" | "low";

export interface SecurityFinding {
  ruleId: string;
  severity: Severity;
  title: string;
  description: string;
  fix: string;
  file: string;
  line: number;
  snippet: string;
}

export type FileRole =
  | "entry"
  | "config"
  | "test"
  | "component"
  | "route"
  | "model"
  | "util"
  | "style"
  | "doc"
  | "other";

export interface FileInfo {
  path: string;
  language: string;
  lines: number;
  size: number;
  /** 関数・メソッドのおおよその数 */
  functions: number;
  /** 分岐数ベースの簡易循環的複雑度 */
  complexity: number;
  role: FileRole;
  /** このファイルが import しているリポジトリ内ファイル */
  imports: string[];
  /** このファイルを import しているリポジトリ内ファイル */
  importedBy: string[];
  /** 外部パッケージ (npm, pip など) */
  externalImports: string[];
  /** 読む順番 (1 始まり)。順番に含まれない場合は null */
  readingOrder: number | null;
  /** 読む順番に入れた理由 */
  readingReason: string | null;
}

export interface ReadingStep {
  order: number;
  path: string;
  reason: string;
}

export interface AnalysisSummary {
  totalFiles: number;
  analyzedFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  entryPoints: string[];
  externalPackages: string[];
  findingsBySeverity: Record<Severity, number>;
  skipped: number;
  truncated: boolean;
}

export interface Analysis {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  files: FileInfo[];
  readingOrder: ReadingStep[];
  findings: SecurityFinding[];
  summary: AnalysisSummary;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
