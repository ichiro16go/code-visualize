// codemap-ignore-file (このファイル自体はルール定義なので検査対象外)
// 正規表現ベースの静的セキュリティチェック
// AI が生成したコードで起こりがちな問題 (秘密情報の直書き・危険な関数・インジェクション等) を検出する
// 行末に "codemap-ignore" と書くとその行は検出しない。ファイル内に "codemap-ignore-file" があればファイル全体を除外

import type { SecurityFinding, Severity } from "../../shared/types.ts";
import type { SourceFile } from "./collect.ts";
import { JS_LIKE } from "../../shared/languages.ts";

interface Rule {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  fix: string;
  pattern: RegExp;
  /** 対象言語。省略時は全ファイル */
  languages?: string[];
  /** マッチした行がこれに当てはまれば除外 (プレースホルダ等) */
  exclude?: RegExp;
  /** テストファイルでは検出しない */
  skipTests?: boolean;
  /** このパスに一致するファイルのみ対象 */
  paths?: RegExp;
  /** コメント行も検査する (秘密情報系)。既定ではコメント行は対象外 */
  inComments?: boolean;
}

const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#(?!!)|<!--|--\s|;)/;

// ブラウザで動くコードらしいパス
const CLIENT_PATHS = /\.(tsx|jsx|vue|svelte|astro)$|(^|\/)(components|pages|client|frontend|web|public|hooks)\//;

const PLACEHOLDER = /(x{4,}|your[_-]?|example|placeholder|dummy|changeme|<[^>]+>|\$\{|process\.env|os\.environ|getenv|import\.meta\.env|\*{4,}|\.\.\.|test|sample|fake)/i;

const JS = [...JS_LIKE];
const SERVER_LANGS = [...JS, "Python", "Ruby", "PHP", "Go", "Java", "Kotlin", "C#"];

const RULES: Rule[] = [
  // ---- 秘密情報 ----
  {
    id: "secret-private-key",
    inComments: true,
    severity: "critical",
    title: "秘密鍵がコードに含まれています",
    description: "秘密鍵 (PRIVATE KEY) がファイルに直接書かれています。リポジトリを見た人なら誰でもサーバーや証明書になりすませます。",
    fix: "鍵ファイルをリポジトリから削除し、鍵を作り直してください (漏れた鍵は無効化が必要)。鍵は環境変数やシークレット管理サービスで渡します。",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: "secret-aws-key",
    inComments: true,
    severity: "critical",
    title: "AWS のアクセスキーが直書きされています",
    description: "AWS アクセスキー ID の形式 (AKIA...) の文字列があります。漏れると高額請求やデータ流出につながります。",
    fix: "AWS コンソールでこのキーを無効化し、新しいキーは環境変数や IAM ロールで渡してください。",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "secret-known-token",
    inComments: true,
    severity: "critical",
    title: "API トークンが直書きされています",
    description: "GitHub / Slack / Stripe / OpenAI / Anthropic / Google などの API キー形式の文字列があります。",
    fix: "トークンを発行元で無効化 (ローテーション) し、.env ファイル + 環境変数で読み込むようにしてください。.env は .gitignore に追加します。",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/,
    exclude: PLACEHOLDER,
  },
  {
    id: "secret-hardcoded",
    inComments: true,
    severity: "high",
    title: "パスワードや秘密の値が直書きされている可能性",
    description: "password / secret / api_key / token などの名前の変数に、文字列が直接代入されています。",
    fix: "値を環境変数 (例: process.env.API_KEY, os.environ['API_KEY']) から読み込むように変更してください。",
    pattern: /\b[\w-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[\w-]*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    exclude: PLACEHOLDER,
    skipTests: true,
  },
  {
    id: "secret-db-url",
    inComments: true,
    severity: "high",
    title: "データベース接続文字列にパスワードが含まれています",
    description: "ユーザー名とパスワード入りの接続 URL が直書きされています。",
    fix: "接続文字列は DATABASE_URL などの環境変数から読み込んでください。",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:"'@/]+:[^\s@"'/]+@/i,
    exclude: PLACEHOLDER,
  },
  {
    id: "frontend-secret-env",
    inComments: true,
    severity: "medium",
    title: "ブラウザに公開される環境変数に秘密情報らしき名前があります",
    description: "NEXT_PUBLIC_ / VITE_ / REACT_APP_ で始まる環境変数はビルド時にブラウザ向けコードへ埋め込まれ、誰でも読めます。",
    fix: "秘密のキーはサーバー側だけで使い、ブラウザからはサーバーの API 経由で呼び出してください。",
    pattern: /\b(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC)_\w*(?:SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|API_KEY|TOKEN)\w*/,
  },
  // ---- 危険な関数・インジェクション ----
  {
    id: "code-eval",
    severity: "high",
    title: "eval / new Function による動的なコード実行",
    description: "文字列をプログラムとして実行しています。外部から入力が混ざると任意のコードを実行される危険があります。",
    fix: "eval を使わずに JSON.parse や明示的な分岐で処理できないか検討してください。",
    pattern: /(?<![\w.$])eval\s*\(|\bnew\s+Function\s*\(/,
    languages: [...JS, "Python", "PHP", "Ruby"],
    skipTests: true,
  },
  {
    id: "command-injection",
    severity: "high",
    title: "シェルコマンドの実行に変数が混ざっています",
    description: "変数を埋め込んだ文字列をシェルで実行しています。入力値によっては任意のコマンドを実行されます (コマンドインジェクション)。",
    fix: "execFile / spawn (JS) や subprocess.run([...]) (Python) のように引数を配列で渡し、shell を使わないでください。",
    pattern: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)|\bos\.system\s*\(|\bsubprocess\.\w+\([^)]*shell\s*=\s*True|\bshell_exec\s*\(|\bpassthru\s*\(|\bsystem\s*\(\s*\$/,
    languages: SERVER_LANGS,
  },
  {
    id: "sql-injection",
    severity: "high",
    title: "SQL を文字列の連結で組み立てています",
    description: "SQL 文に変数を直接埋め込んでいます。入力値によってデータベースを不正に操作されます (SQL インジェクション)。",
    fix: "プレースホルダ (?, $1, :name) を使ったパラメータ化クエリや ORM を使ってください。",
    pattern: /(?:\b(?:query|execute|exec|raw|prepare|run|all|get)\s*\(\s*)(?:`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^`]*\$\{|["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*["']\s*(?:\+|%|\.format)|f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*\{)/i,
    languages: SERVER_LANGS,
  },
  {
    id: "xss-html-injection",
    severity: "medium",
    title: "HTML を直接書き込んでいます (XSS の可能性)",
    description: "innerHTML / dangerouslySetInnerHTML / v-html / document.write でHTMLを挿入しています。利用者の入力が含まれると、悪意あるスクリプトが実行されます。",
    fix: "textContent を使うか、DOMPurify などでサニタイズしてから挿入してください。",
    skipTests: true,
    pattern: /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|dangerouslySetInnerHTML|\bv-html\s*=|document\.write\s*\(|insertAdjacentHTML\s*\(|\{@html\s/,
    languages: [...JS, "HTML"],
  },
  {
    id: "unsafe-deserialize",
    severity: "high",
    title: "安全でないデシリアライズ",
    description: "pickle / yaml.load / unserialize / Marshal.load は、細工されたデータを読み込むと任意のコードを実行されることがあります。",
    fix: "信頼できないデータには json や yaml.safe_load を使ってください。",
    pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)|\bunserialize\s*\(|\bMarshal\.load\b/,
    languages: ["Python", "PHP", "Ruby"],
  },
  // ---- 通信・設定 ----
  {
    id: "tls-verify-disabled",
    severity: "high",
    title: "HTTPS の証明書検証が無効になっています",
    description: "証明書の検証を無効にすると、通信を盗聴・改ざんされても気付けません (中間者攻撃)。",
    fix: "検証を有効に戻してください。自己署名証明書を使う場合は CA 証明書を明示的に指定します。",
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/,
  },
  {
    id: "cors-wildcard",
    severity: "medium",
    title: "CORS ですべてのオリジンを許可しています",
    description: "どのサイトからでも API を呼べる設定です。認証情報付きの API だと、他サイトから利用者のデータを読まれる恐れがあります。",
    fix: "許可するオリジン (自分のフロントエンドのドメイン) を明示的に列挙してください。",
    pattern: /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|\borigin\s*:\s*(?:["']\*["']|true)\b|allow_origins\s*=\s*\[\s*["']\*["']\s*\]|CORS_ORIGIN_ALLOW_ALL\s*=\s*True/,
  },
  {
    id: "debug-enabled",
    severity: "medium",
    title: "デバッグモードが有効のままです",
    description: "本番でデバッグモードが有効だと、エラー画面から内部情報が漏れたり、任意コード実行につながることがあります。",
    fix: "環境変数でデバッグモードを切り替え、本番では必ず無効にしてください。",
    pattern: /\bDEBUG\s*=\s*True\b|\.run\([^)]*debug\s*=\s*True|app\.debug\s*=\s*True/,
    languages: ["Python"],
  },
  {
    id: "weak-hash",
    severity: "medium",
    title: "弱いハッシュ関数 (MD5 / SHA-1) を使っています",
    description: "MD5 や SHA-1 は衝突攻撃が可能で、パスワード保存や署名には不適切です。",
    fix: "パスワードには bcrypt / argon2 / scrypt、それ以外には SHA-256 以上を使ってください。",
    pattern: /createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|\bmd5\s*\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"|\bmd5\.New\(|\bsha1\.New\(/i,
    languages: SERVER_LANGS,
  },
  {
    id: "insecure-random",
    severity: "medium",
    title: "推測可能な乱数でトークン等を生成しています",
    description: "Math.random() や random モジュールは予測可能なため、トークン・パスワード・セッションIDの生成に使うと危険です。",
    fix: "crypto.randomUUID() / crypto.getRandomValues() (JS) や secrets モジュール (Python) を使ってください。",
    pattern: /(?:token|secret|password|session|nonce|otp|salt|key)\w*\s*[:=][^\n;]*(?:Math\.random\(\)|random\.(?:random|randint|choice)\()/i,
    languages: [...JS, "Python"],
  },
  {
    id: "jwt-weak",
    severity: "high",
    title: "JWT の検証が不十分な可能性",
    description: "JWT を検証せずにデコードしている、または署名アルゴリズム 'none' を許可しています。トークンを偽造されます。",
    fix: "jwt.verify() で署名を検証し、許可するアルゴリズムを明示してください。",
    pattern: /algorithms?\s*[:=]\s*\[?\s*["']none["']|verify_signature["']?\s*:\s*False|jwt\.decode\([^)]*verify\s*=\s*False/i,
  },
  {
    id: "supabase-service-role",
    severity: "high",
    title: "Supabase の service_role キーをクライアントで使っている可能性",
    description: "service_role キーは RLS (行レベルセキュリティ) を無視して全データにアクセスできます。ブラウザに含めると誰でも全データを操作できます。",
    fix: "ブラウザでは anon キーを使い、service_role キーはサーバー側のみで使ってください。RLS を必ず有効にします。",
    pattern: /service_role|SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/,
    languages: JS,
    paths: CLIENT_PATHS,
  },
  {
    id: "http-plain",
    severity: "low",
    title: "暗号化されていない http:// で通信しています",
    description: "http:// の通信は途中で盗聴・改ざんされる可能性があります。",
    fix: "可能であれば https:// を使ってください。",
    pattern: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.w3\.org|schemas\.|json-schema\.org|[\w.-]*example\.|[\w.-]*\.local\b|\$\{)[\w.-]+/,
    languages: [...JS, "Python", "Go", "Ruby", "PHP", "Java", "Kotlin"],
    skipTests: true,
  },
  {
    id: "todo-security",
    inComments: true,
    severity: "low",
    title: "セキュリティに関する TODO が残っています",
    description: "認証やバリデーションなどの処理が「後で実装」のまま残っている可能性があります。",
    fix: "TODO の内容を確認し、公開前に対応してください。",
    pattern: /(?:TODO|FIXME|HACK|XXX)\b[^\n]*(?:auth|security|validat|sanitiz|password|token|permission|認証|権限|検証|セキュリティ)/i,
  },
];

const MAX_PER_RULE_PER_FILE = 5;

function isTestPath(p: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|mocks?|__mocks__)\//i.test(p) || /[._-](test|spec)\.\w+$/i.test(p) || /(^|\/)test_[^/]*\.py$/.test(p);
}

export function scanFile(file: SourceFile, language: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = file.content.split("\n");
  const test = isTestPath(file.path);
  if (file.content.includes("codemap-ignore-file")) return findings;
  const isClientModule = /^\s*["']use client["']/m.test(file.content);

  // ファイル単位のチェック
  const base = file.path.split("/").pop() ?? "";
  if (/^\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/.test(base) && /^\s*[A-Z_][A-Z0-9_]*\s*=\s*\S+/m.test(file.content)) {
    findings.push({
      ruleId: "env-file-committed",
      severity: "high",
      title: ".env ファイルがリポジトリに含まれています",
      description: ".env には API キーやパスワードを書くことが多く、リポジトリに含めると公開されてしまいます。",
      fix: ".env を .gitignore に追加し、git の履歴からも削除してください。含まれていたキーはローテーションします。共有用には .env.example を使います。",
      file: file.path,
      line: 1,
      snippet: lines.find((l) => /=/.test(l))?.replace(/=.*/, "=****") ?? "",
    });
  }

  for (const rule of RULES) {
    if (rule.languages && !rule.languages.includes(language)) continue;
    if (rule.skipTests && test) continue;
    if (rule.paths && !rule.paths.test(file.path) && !isClientModule) continue;
    let count = 0;
    for (let i = 0; i < lines.length && count < MAX_PER_RULE_PER_FILE; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      if (!rule.pattern.test(line) || line.includes("codemap-ignore")) continue;
      if (!rule.inComments && COMMENT_LINE.test(line)) continue;
      if (rule.exclude && rule.exclude.test(line)) continue;
      count++;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        fix: rule.fix,
        file: file.path,
        line: i + 1,
        snippet: maskSecrets(line.trim()).slice(0, 240),
      });
    }
  }
  return findings;
}

/** スニペットに含まれる秘密情報らしき値を伏せ字にする */
export function maskSecrets(text: string): string {
  return text.replace(/(["'`])([^"'`\s]{8,})\1/g, (_m, q: string, v: string) => `${q}${v.slice(0, 4)}${"*".repeat(Math.min(12, v.length - 4))}${q}`)
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1****************")
    .replace(/:\/\/([^\s:"'@/]+):[^\s@"'/]+@/g, "://$1:****@");
}

export const SECURITY_RULE_COUNT = RULES.length + 1;
