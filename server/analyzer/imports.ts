// 各言語の import / require を抽出し、リポジトリ内のファイルに解決する

import { extOf, JS_LIKE } from "../../shared/languages.ts";
import type { SourceFile } from "./collect.ts";

export interface ResolvedImports {
  internal: string[];
  external: string[];
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm",
  "wasi", "worker_threads", "zlib",
]);

const PY_STDLIB = new Set([
  "abc", "argparse", "asyncio", "base64", "collections", "contextlib", "copy", "csv", "dataclasses",
  "datetime", "decimal", "enum", "functools", "glob", "hashlib", "hmac", "html", "http", "importlib",
  "inspect", "io", "itertools", "json", "logging", "math", "multiprocessing", "operator", "os",
  "pathlib", "pickle", "platform", "pprint", "queue", "random", "re", "secrets", "shutil", "signal",
  "socket", "sqlite3", "ssl", "statistics", "string", "struct", "subprocess", "sys", "tempfile",
  "textwrap", "threading", "time", "traceback", "types", "typing", "unittest", "urllib", "uuid",
  "warnings", "weakref", "xml", "zipfile", "__future__",
]);

const JS_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "json", "css", "scss"];

function stripComments(code: string, style: "c" | "hash"): string {
  if (style === "hash") return code.replace(/^\s*#.*$/gm, "");
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function joinPath(a: string, b: string): string {
  return normalize(a ? `${a}/${b}` : b);
}

/** 解析に使うリポジトリ全体のインデックス */
export class RepoIndex {
  readonly paths: Set<string>;
  readonly pyModules = new Map<string, string>();
  readonly javaClasses = new Map<string, string>();
  readonly goModule: string | null;
  readonly jsAliases: Array<{ prefix: string; targets: string[] }> = [];
  readonly dirFiles = new Map<string, string[]>();

  constructor(files: SourceFile[]) {
    this.paths = new Set(files.map((f) => f.path));
    for (const f of files) {
      const d = dirname(f.path);
      const list = this.dirFiles.get(d) ?? [];
      list.push(f.path);
      this.dirFiles.set(d, list);

      const ext = extOf(f.path);
      if (ext === "py") {
        const noExt = f.path.slice(0, -3).replace(/\/__init__$/, "");
        const parts = noExt.split("/");
        // src/pkg/mod.py は "src.pkg.mod", "pkg.mod", "mod" のどれでも解決できるようにする (短い方は先勝ちしない)
        for (let i = 0; i < parts.length; i++) {
          const name = parts.slice(i).join(".");
          if (!this.pyModules.has(name) || i === 0) this.pyModules.set(name, f.path);
        }
      }
      if (ext === "java" || ext === "kt" || ext === "scala") {
        const pkg = /^\s*package\s+([\w.]+)/m.exec(f.content)?.[1];
        const cls = (f.path.split("/").pop() ?? "").replace(/\.\w+$/, "");
        if (pkg) this.javaClasses.set(`${pkg}.${cls}`, f.path);
      }
    }

    const goMod = files.find((f) => f.path === "go.mod");
    this.goModule = goMod ? (/^module\s+(\S+)/m.exec(goMod.content)?.[1] ?? null) : null;

    // tsconfig / jsconfig の paths エイリアス
    for (const f of files) {
      if (!/(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(f.path)) continue;
      try {
        const json = JSON.parse(stripComments(f.content, "c").replace(/,\s*([}\]])/g, "$1"));
        const opts = json.compilerOptions ?? {};
        const base = joinPath(dirname(f.path), opts.baseUrl ?? ".");
        for (const [key, value] of Object.entries<string[]>(opts.paths ?? {})) {
          this.jsAliases.push({
            prefix: key.replace(/\*$/, ""),
            targets: value.map((v) => joinPath(base, v.replace(/\*$/, ""))),
          });
        }
      } catch {
        // 壊れた設定ファイルは無視
      }
    }
    // よく使われるエイリアスの既定値
    if (!this.jsAliases.some((a) => a.prefix === "@/")) {
      const srcRoot = [...this.paths].some((p) => p.startsWith("src/")) ? "src" : "";
      this.jsAliases.push({ prefix: "@/", targets: [srcRoot] }, { prefix: "~/", targets: [srcRoot] });
    }
  }

  resolveFile(candidate: string): string | null {
    const base = normalize(candidate);
    if (this.paths.has(base)) return base;
    const withoutJsExt = base.replace(/\.(m|c)?jsx?$/, "");
    for (const ext of JS_EXTS) {
      if (this.paths.has(`${base}.${ext}`)) return `${base}.${ext}`;
      // TS の ESM では "./foo.js" と書いて foo.ts を指す
      if (withoutJsExt !== base && this.paths.has(`${withoutJsExt}.${ext}`)) return `${withoutJsExt}.${ext}`;
    }
    for (const ext of JS_EXTS) {
      if (this.paths.has(`${base}/index.${ext}`)) return `${base}/index.${ext}`;
    }
    return null;
  }
}

function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function resolveJs(spec: string, from: string, index: RepoIndex, out: ResolvedImports): void {
  if (/^(https?:|data:|virtual:|\0)/.test(spec)) return;
  const clean = spec.split("?")[0];
  if (clean.startsWith(".") || clean.startsWith("/")) {
    const target = clean.startsWith("/") ? clean.slice(1) : joinPath(dirname(from), clean);
    const hit = index.resolveFile(target);
    if (hit) out.internal.push(hit);
    return;
  }
  for (const alias of index.jsAliases) {
    if (alias.prefix && clean.startsWith(alias.prefix)) {
      for (const t of alias.targets) {
        const hit = index.resolveFile(joinPath(t, clean.slice(alias.prefix.length)));
        if (hit) {
          out.internal.push(hit);
          return;
        }
      }
    }
  }
  const name = packageName(clean.replace(/^node:/, ""));
  if (clean.startsWith("node:") || NODE_BUILTINS.has(name)) return;
  out.external.push(name);
}

function extractJs(code: string): string[] {
  const src = stripComments(code, "c");
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /@import\s+(?:url\()?["']([^"']+)["']/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) specs.push(m[1]);
  return specs;
}

function resolvePython(code: string, from: string, index: RepoIndex, out: ResolvedImports): void {
  const src = stripComments(code, "hash");
  const lookup = (mod: string): string | null => index.pyModules.get(mod) ?? null;
  const pkgDir = dirname(from);

  const handleAbsolute = (mod: string, names: string[]) => {
    let hit = false;
    for (const n of names) {
      const r = lookup(`${mod}.${n}`);
      if (r) {
        out.internal.push(r);
        hit = true;
      }
    }
    const r = lookup(mod);
    if (r) {
      out.internal.push(r);
      hit = true;
    }
    if (!hit) {
      const top = mod.split(".")[0];
      if (top && !PY_STDLIB.has(top)) out.external.push(top);
    }
  };

  for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w \t,*]+))/gm)) {
    const dots = m[1].length;
    const mod = m[2];
    const names = (m[3] ?? m[4]).split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => s && s !== "*");
    if (dots === 0) {
      handleAbsolute(mod, names);
      continue;
    }
    let base = pkgDir;
    for (let i = 1; i < dots; i++) base = dirname(base);
    const modPath = joinPath(base, mod.replace(/\./g, "/"));
    const candidates = [`${modPath}.py`, `${modPath}/__init__.py`, ...names.map((n) => `${joinPath(modPath, n)}.py`)];
    for (const c of candidates) if (index.paths.has(c)) out.internal.push(c);
  }
  for (const m of src.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
    for (const part of m[1].split(",")) handleAbsolute(part.trim().split(/\s+/)[0], []);
  }
}

function resolveGo(code: string, index: RepoIndex, out: ResolvedImports): void {
  const specs: string[] = [];
  for (const m of code.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) specs.push(m[1]);
  for (const block of code.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/(?:^|\s)(?:[\w.]+\s+)?"([^"]+)"/g)) specs.push(m[1]);
  }
  for (const spec of specs) {
    if (index.goModule && (spec === index.goModule || spec.startsWith(`${index.goModule}/`))) {
      const dir = spec.slice(index.goModule.length).replace(/^\//, "");
      for (const f of index.dirFiles.get(dir) ?? []) {
        if (f.endsWith(".go") && !f.endsWith("_test.go")) out.internal.push(f);
      }
    } else if (spec.includes(".")) {
      out.external.push(spec.split("/").slice(0, 3).join("/"));
    }
  }
}

function resolveRust(code: string, from: string, index: RepoIndex, out: ResolvedImports): void {
  const dir = dirname(from);
  const base = from.split("/").pop() ?? "";
  const modDir = /^(main|lib|mod)\.rs$/.test(base) ? dir : joinPath(dir, base.replace(/\.rs$/, ""));
  for (const m of stripComments(code, "c").matchAll(/^\s*(?:pub(?:\([\w ]+\))?\s+)?mod\s+(\w+)\s*;/gm)) {
    for (const c of [`${joinPath(modDir, m[1])}.rs`, `${joinPath(modDir, m[1])}/mod.rs`]) {
      if (index.paths.has(c)) out.internal.push(c);
    }
  }
  for (const m of code.matchAll(/^\s*(?:pub\s+)?use\s+([a-zA-Z_]\w*)::/gm)) {
    if (!["crate", "self", "super", "std", "core", "alloc"].includes(m[1])) out.external.push(m[1]);
  }
}

function resolveJava(code: string, index: RepoIndex, out: ResolvedImports): void {
  for (const m of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/gm)) {
    const name = m[1];
    const hit = index.javaClasses.get(name) ?? index.javaClasses.get(name.split(".").slice(0, -1).join("."));
    if (hit) out.internal.push(hit);
    else if (!/^(java|javax|kotlin|scala|android)\./.test(name)) out.external.push(name.split(".").slice(0, 2).join("."));
  }
}

function resolveRelativeList(specs: string[], from: string, exts: string[], index: RepoIndex, out: ResolvedImports): void {
  for (const spec of specs) {
    const base = joinPath(dirname(from), spec);
    for (const c of [base, ...exts.map((e) => `${base}.${e}`)]) {
      if (index.paths.has(c)) {
        out.internal.push(c);
        break;
      }
    }
  }
}

export function resolveImports(file: SourceFile, language: string, index: RepoIndex): ResolvedImports {
  const out: ResolvedImports = { internal: [], external: [] };
  const code = file.content;

  if (JS_LIKE.has(language) || language === "CSS" || language === "SCSS" || language === "HTML") {
    if (language === "HTML") {
      for (const m of code.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/g)) resolveJs(m[1].startsWith("/") ? m[1] : `./${m[1]}`, file.path, index, out);
    } else {
      for (const spec of extractJs(code)) resolveJs(spec, file.path, index, out);
    }
  } else if (language === "Python") {
    resolvePython(code, file.path, index, out);
  } else if (language === "Go") {
    resolveGo(code, index, out);
  } else if (language === "Rust") {
    resolveRust(code, file.path, index, out);
  } else if (language === "Java" || language === "Kotlin" || language === "Scala") {
    resolveJava(code, index, out);
  } else if (language === "Ruby") {
    const specs = [...code.matchAll(/require_relative\s+["']([^"']+)["']/g)].map((m) => m[1]);
    resolveRelativeList(specs, file.path, ["rb"], index, out);
    for (const m of code.matchAll(/^\s*require\s+["']([^"'./][^"']*)["']/gm)) out.external.push(m[1]);
  } else if (language === "PHP") {
    const specs = [...code.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']\/?([^"']+)["']/g)].map((m) => m[1]);
    resolveRelativeList(specs, file.path, [], index, out);
  } else if (language === "C" || language === "C++") {
    const specs = [...code.matchAll(/^\s*#include\s+"([^"]+)"/gm)].map((m) => m[1]);
    resolveRelativeList(specs, file.path, [], index, out);
  }

  out.internal = [...new Set(out.internal)].filter((p) => p !== file.path);
  out.external = [...new Set(out.external)];
  return out;
}
