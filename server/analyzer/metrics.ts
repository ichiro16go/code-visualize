// 行数・関数数・簡易複雑度の計算と、ファイルの役割分類

import type { FileRole } from "../../shared/types.ts";
import { CODE_LANGUAGES, JS_LIKE } from "../../shared/languages.ts";

export interface FileMetrics {
  lines: number;
  functions: number;
  complexity: number;
}

const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /\bfunction\b\s*\*?\s*[\w$]*\s*\(/g,
    /(?:^|[=(,:]\s*|\breturn\s+)(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*=>/gm,
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b)[\w$]+\s*\([^()]*\)\s*(?::\s*[\w<>[\]|, .]+)?\s*\{/gm,
  ],
  Python: [/^\s*(?:async\s+)?def\s+\w+/gm],
  Go: [/^func\s+/gm],
  Rust: [/\bfn\s+\w+/g],
  Ruby: [/^\s*def\s+/gm],
  PHP: [/\bfunction\s+\w+/g],
  Shell: [/^\s*(?:function\s+)?\w+\s*\(\)\s*\{/gm],
  Lua: [/\bfunction\b/g],
  default: [/^\s*(?:public|private|protected|internal|static|override|fun|func|def|void|int|bool|string|async|final|\w+<[^>]*>)\s+[\w<>[\], ]*\w+\s*\([^;]*$/gm],
};

const BRANCH_PATTERN = /\b(if|elif|else\s+if|for|foreach|while|case|catch|except|when|guard|unless|until|rescue)\b|&&|\|\||\?\?|\?(?=[^.:?]*:)/g;

function stripStringsAndComments(code: string, language: string): string {
  let s = code;
  if (language === "Python" || language === "Ruby" || language === "Shell") {
    s = s.replace(/("""|''')[\s\S]*?\1/g, '""').replace(/#.*$/gm, "");
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  }
  return s.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
}

export function computeMetrics(content: string, language: string): FileMetrics {
  const lines = content.split("\n").filter((l) => l.trim() !== "").length;
  if (!CODE_LANGUAGES.has(language)) return { lines, functions: 0, complexity: 0 };

  const code = stripStringsAndComments(content, language);
  const key = JS_LIKE.has(language) ? "js" : FUNCTION_PATTERNS[language] ? language : "default";
  let functions = 0;
  for (const re of FUNCTION_PATTERNS[key]) functions += [...code.matchAll(re)].length;

  const branches = [...code.matchAll(BRANCH_PATTERN)].length;
  return { lines, functions, complexity: 1 + branches };
}

export function classifyRole(path: string, language: string, content: string): FileRole {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress)\//.test(lower) || /[._-](test|spec)\.\w+$/.test(base) || /^test_.*\.py$/.test(base) || base.endsWith("_test.go")) return "test";
  if (language === "Markdown" || language === "Text") return "doc";
  if (["CSS", "SCSS", "Less"].includes(language)) return "style";
  if (
    ["JSON", "YAML", "TOML", "Config", "Env", "Docker", "Make", "XML", "Terraform"].includes(language) ||
    /(^|\.)(config|conf|rc)\.(\w+)$/.test(base) ||
    /^(vite|webpack|rollup|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|eslint|prettier|tsup)\.config\./.test(base) ||
    base === "setup.py" || base === "conftest.py"
  ) return "config";
  if (/(^|\/)(routes?|pages|app\/api|api|controllers?|handlers?|endpoints?|views)\//.test(lower) || /(route|router|controller|handler)s?\.\w+$/.test(base)) return "route";
  if (/(^|\/)(models?|entities|schemas?|types?|domain|db|database|migrations?)\//.test(lower) || /(model|schema|entity|types?)\.\w+$/.test(base) || language === "Prisma" || language === "SQL") return "model";
  if (/\.(tsx|jsx|vue|svelte|astro)$/.test(base) || /(^|\/)components?\//.test(lower)) return "component";
  if (/(^|\/)(utils?|helpers?|common|shared|hooks)\//.test(lower) || /(util|utils|helper|helpers)\.\w+$/.test(base)) return "util";
  if (CODE_LANGUAGES.has(language) && /\bmain\b/.test(base) && content.length > 0) return "entry";
  return "other";
}
