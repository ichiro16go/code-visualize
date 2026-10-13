// 拡張子から言語を判定する

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  swift: "Swift",
  dart: "Dart",
  lua: "Lua",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  sql: "SQL",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "SCSS",
  less: "Less",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  md: "Markdown",
  mdx: "Markdown",
  txt: "Text",
  ini: "Config",
  cfg: "Config",
  conf: "Config",
  env: "Env",
  graphql: "GraphQL",
  gql: "GraphQL",
  prisma: "Prisma",
  tf: "Terraform",
};

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: "Docker",
  makefile: "Make",
  gemfile: "Ruby",
  rakefile: "Ruby",
  procfile: "Config",
  ".env": "Env",
  ".gitignore": "Config",
  ".dockerignore": "Config",
  ".npmrc": "Config",
  "go.mod": "Config",
  "requirements.txt": "Config",
};

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function detectLanguage(path: string): string | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  if (base.startsWith(".env")) return "Env";
  if (base.startsWith("dockerfile")) return "Docker";
  return EXT_LANG[extOf(path)] ?? null;
}

/** import 解析・複雑度計算の対象となるプログラミング言語 */
export const CODE_LANGUAGES = new Set([
  "TypeScript",
  "JavaScript",
  "Vue",
  "Svelte",
  "Astro",
  "Python",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "Scala",
  "Ruby",
  "PHP",
  "C#",
  "C",
  "C++",
  "Swift",
  "Dart",
  "Lua",
  "Shell",
]);

export const JS_LIKE = new Set(["TypeScript", "JavaScript", "Vue", "Svelte", "Astro"]);

/** サンプル・ドキュメント・ベンチマーク等、本体ではないコードの置き場所 */
export const AUX_PATH = /(^|\/)(examples?|samples?|demos?|docs?|benchmarks?|bench|fixtures?|playground|storybook|\.storybook|stories)\//i;
