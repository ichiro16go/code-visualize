// codemap-ignore-file (テスト用の危険なコード片を含むため)
import { describe, expect, it } from "vitest";
import { filterSources, type SourceFile } from "../server/analyzer/collect.ts";
import { analyze } from "../server/analyzer/index.ts";
import { scanFile } from "../server/analyzer/security.ts";
import { parseGitHubUrl } from "../server/sources.ts";

function repo(files: Record<string, string>) {
  const sources: SourceFile[] = Object.entries(files).map(([path, content]) => ({ path, content, size: content.length }));
  return analyze(filterSources(sources), { name: "test", source: "test" });
}

describe("import 解析", () => {
  it("TypeScript の相対 import・エイリアス・index 解決", () => {
    const a = repo({
      "package.json": JSON.stringify({ name: "x", dependencies: { react: "1" } }),
      "tsconfig.json": `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }`,
      "src/main.tsx": `import React from "react";\nimport { App } from "./App";\nimport "./styles.css";`,
      "src/App.tsx": `import { util } from "@lib/util.js";\nimport Button from "@/components";\nexport function App() { return util(); }`,
      "src/lib/util.ts": `export const util = () => 1;`,
      "src/components/index.tsx": `export default function Button() {}`,
      "src/styles.css": `body {}`,
      "node_modules/react/index.js": `module.exports = {}`,
    });
    const byPath = Object.fromEntries(a.files.map((f) => [f.path, f]));
    expect(byPath["node_modules/react/index.js"]).toBeUndefined();
    expect(byPath["src/main.tsx"].imports.sort()).toEqual(["src/App.tsx", "src/styles.css"]);
    expect(byPath["src/main.tsx"].externalImports).toEqual(["react"]);
    expect(byPath["src/App.tsx"].imports.sort()).toEqual(["src/components/index.tsx", "src/lib/util.ts"]);
    expect(byPath["src/lib/util.ts"].importedBy).toEqual(["src/App.tsx"]);
    expect(a.summary.entryPoints[0]).toBe("src/main.tsx");
  });

  it("Python の絶対・相対 import", () => {
    const a = repo({
      "main.py": `from app.services import user\nimport app.db\nimport requests\nimport os\nif __name__ == "__main__":\n    pass`,
      "app/__init__.py": ``,
      "app/db.py": `from .models import User`,
      "app/models.py": `class User: pass`,
      "app/services/user.py": `from ..db import connect`,
    });
    const byPath = Object.fromEntries(a.files.map((f) => [f.path, f]));
    expect(byPath["main.py"].imports.sort()).toEqual(["app/db.py", "app/services/user.py"]);
    expect(byPath["main.py"].externalImports).toEqual(["requests"]);
    expect(byPath["app/db.py"].imports).toEqual(["app/models.py"]);
    expect(byPath["app/services/user.py"].imports).toEqual(["app/db.py"]);
    expect(a.summary.entryPoints).toContain("main.py");
  });

  it("Go のモジュール内 import", () => {
    const a = repo({
      "go.mod": `module example.com/app\n\ngo 1.22`,
      "main.go": `package main\n\nimport (\n  "fmt"\n  "example.com/app/internal/store"\n  "github.com/gin-gonic/gin"\n)\n\nfunc main() {}`,
      "internal/store/store.go": `package store\nfunc Get() {}`,
      "internal/store/store_test.go": `package store`,
    });
    const main = a.files.find((f) => f.path === "main.go")!;
    expect(main.imports).toEqual(["internal/store/store.go"]);
    expect(main.externalImports).toEqual(["github.com/gin-gonic/gin"]);
  });
});

describe("読む順番", () => {
  it("README → マニフェスト → エントリー → 依存先 の順", () => {
    const a = repo({
      "README.md": "# hi",
      "package.json": "{}",
      "src/index.ts": `import "./a"; import "./b";`,
      "src/a.ts": `import "./shared";`,
      "src/b.ts": `import "./shared";`,
      "src/shared.ts": `export {}`,
      "src/a.test.ts": `import "./a";`,
    });
    expect(a.readingOrder.map((s) => s.path)).toEqual(["README.md", "package.json", "src/index.ts", "src/a.ts", "src/b.ts", "src/shared.ts"]);
    expect(a.files.find((f) => f.path === "src/a.test.ts")!.readingOrder).toBeNull();
  });
});

describe("セキュリティチェック", () => {
  const scan = (path: string, content: string, lang: string) => scanFile({ path, content, size: content.length }, lang).map((f) => f.ruleId);

  it("秘密情報の直書きを検出し、プレースホルダは無視する", () => {
    expect(scan("src/config.ts", `const apiKey = "a8f3kd93jf02kd8s";`, "TypeScript")).toContain("secret-hardcoded");
    expect(scan("src/config.ts", `const apiKey = "your-api-key-here";`, "TypeScript")).toEqual([]);
    expect(scan("src/config.ts", `const apiKey = process.env.API_KEY;`, "TypeScript")).toEqual([]);
    expect(scan("src/aws.ts", `const k = "AKIAIOSFODNN7ABCDEFG";`, "TypeScript")).toContain("secret-aws-key");
    expect(scan("key.pem", `-----BEGIN RSA PRIVATE KEY-----`, "Text")).toContain("secret-private-key");
  });

  it("インジェクション系を検出する", () => {
    expect(scan("db.ts", "db.query(`SELECT * FROM users WHERE id = ${id}`)", "TypeScript")).toContain("sql-injection");
    expect(scan("db.py", `cursor.execute(f"SELECT * FROM users WHERE id = {uid}")`, "Python")).toContain("sql-injection");
    expect(scan("db.ts", "db.query('SELECT * FROM users WHERE id = ?', [id])", "TypeScript")).toEqual([]);
    expect(scan("run.ts", "exec(`ls ${dir}`)", "TypeScript")).toContain("command-injection");
    expect(scan("run.py", `subprocess.run(cmd, shell=True)`, "Python")).toContain("command-injection");
    expect(scan("a.tsx", `<div dangerouslySetInnerHTML={{ __html: x }} />`, "TypeScript")).toContain("xss-html-injection");
    expect(scan("a.ts", `el.innerHTML = name;`, "TypeScript")).toContain("xss-html-injection");
  });

  it(".env ファイルのコミットを検出 (.env.example は除外)", () => {
    expect(scan(".env", "API_KEY=abc123", "Env")).toContain("env-file-committed");
    expect(scan(".env.local", "API_KEY=abc123", "Env")).toContain("env-file-committed");
    expect(scan(".env.example", "API_KEY=", "Env")).toEqual([]);
  });

  it("スニペット内の秘密情報は伏せ字にする", () => {
    const [finding] = scanFile({ path: "a.ts", content: `const password = "supersecretvalue1";`, size: 10 }, "TypeScript");
    expect(finding.snippet).not.toContain("supersecretvalue1");
  });
});

describe("GitHub URL の解釈", () => {
  it.each([
    ["https://github.com/facebook/react", { owner: "facebook", repo: "react", branch: undefined, subdir: undefined }],
    ["github.com/facebook/react.git", { owner: "facebook", repo: "react", branch: undefined, subdir: undefined }],
    ["https://github.com/vercel/next.js/tree/canary/packages/next", { owner: "vercel", repo: "next.js", branch: "canary", subdir: "packages/next" }],
    ["owner/repo", { owner: "owner", repo: "repo" }],
  ])("%s", (input, expected) => {
    expect(parseGitHubUrl(input)).toEqual(expected);
  });
  it("GitHub 以外は null", () => {
    expect(parseGitHubUrl("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("誤検知の抑制", () => {
  const scan = (path: string, content: string, lang: string) => scanFile({ path, content, size: content.length }, lang).map((f) => f.ruleId);
  it("コメント行のコード例は検出しない (秘密情報はコメントでも検出)", () => {
    expect(scan("a.js", " *   next: 'http://api.example.com/users'", "JavaScript")).toEqual([]);
    expect(scan("a.js", "// el.innerHTML = x", "JavaScript")).toEqual([]);
    expect(scan("a.js", "// key: AKIAIOSFODNN7ABCDEFG", "JavaScript")).toContain("secret-aws-key");
  });
  it("codemap-ignore で行単位・ファイル単位で除外できる", () => {
    expect(scan("a.ts", "el.innerHTML = x; // codemap-ignore", "TypeScript")).toEqual([]);
    expect(scan("a.ts", "// codemap-ignore-file\nel.innerHTML = x;", "TypeScript")).toEqual([]);
  });
  it("Supabase service_role はクライアント側のファイルのみ", () => {
    expect(scan("server/admin.ts", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;", "TypeScript")).toEqual([]);
    expect(scan("src/components/A.tsx", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;", "TypeScript")).toContain("supabase-service-role");
    expect(scan("src/lib/a.ts", "\"use client\";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;", "TypeScript")).toContain("supabase-service-role");
  });
});

describe("Next.js のルート", () => {
  it("import されない route.ts も読む順番に入る", () => {
    const a = repo({
      "src/app/page.tsx": `export default function P() {}`,
      "src/app/api/users/route.ts": `import { db } from "@/lib/db";`,
      "src/lib/db.ts": `export const db = 1;`,
    });
    expect(a.readingOrder.map((s) => s.path)).toContain("src/app/api/users/route.ts");
  });
});
