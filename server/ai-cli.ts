// Claude Code CLI (`claude -p`) 経由で Claude を呼び出す
// Claude の Pro / Max プランでログイン済みなら、API キーなしでプランの利用枠から使える

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export const CLAUDE_BIN = process.env.CODEMAP_CLAUDE_BIN ?? "claude";

export class CliError extends Error {}

/** API キーを渡すと CLI がプランではなく API 課金で動いてしまうので、子プロセスからは外す */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  return env;
}

const isWindows = process.platform === "win32";

function run(args: string[], options: { cwd?: string; input?: string; signal?: AbortSignal }) {
  // Windows の npm 版は claude.cmd なのでシェル経由で起動する (引数は単純な文字列のみ渡す)
  const finalArgs = isWindows ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args;
  const child = spawn(CLAUDE_BIN, finalArgs, {
    cwd: options.cwd,
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWindows,
    signal: options.signal,
  });
  child.stdin.end(options.input ?? "");
  return child;
}

export interface CliStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
}

let statusCache: { at: number; value: CliStatus } | null = null;

/** `claude auth status` でログイン状態を確認する (結果は 1 分キャッシュ) */
export async function cliStatus(): Promise<CliStatus> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const value = await new Promise<CliStatus>((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: CliStatus) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = run(["auth", "status"], {});
      const timer = setTimeout(() => {
        child.kill();
        done({ installed: true, loggedIn: false });
      }, 20_000);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => {
        clearTimeout(timer);
        done({ installed: false, loggedIn: false });
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
          done({ installed: true, loggedIn: !!json.loggedIn, authMethod: json.authMethod });
        } catch {
          done({ installed: true, loggedIn: false });
        }
      });
    } catch {
      done({ installed: false, loggedIn: false });
    }
  });
  statusCache = { at: Date.now(), value };
  return value;
}

let workDir: Promise<string> | null = null;
/** CLAUDE.md などを拾わないよう、空の作業フォルダで CLI を動かす */
function getWorkDir(): Promise<string> {
  workDir ??= fs.mkdtemp(path.join(os.tmpdir(), "codemap-claude-"));
  return workDir;
}

interface StreamLine {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  event?: { type: string; delta?: { type: string; text?: string } };
  rate_limit_info?: { status?: string; resetsAt?: number };
}

export async function streamViaCli(
  system: string,
  prompt: string,
  onText: (text: string) => Promise<void> | void,
  options: { model?: string; effort?: string; signal?: AbortSignal },
): Promise<void> {
  const cwd = await getWorkDir();
  const systemFile = path.join(cwd, `system-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(systemFile, system);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // ファイル操作やコマンド実行はさせず、文章で答えるだけにする
    "--tools", "",
    "--no-session-persistence",
    "--system-prompt-file", systemFile,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);

  try {
    const child = run(args, { cwd, input: prompt, signal: options.signal });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const spawnError = new Promise<never>((_, reject) => {
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (e.name === "AbortError") reject(e);
        else if (e.code === "ENOENT") {
          reject(new CliError("Claude Code (claude コマンド) が見つかりません。Claude Code をインストールして `claude` でログインしてください。"));
        } else reject(new CliError(`Claude Code の起動に失敗しました: ${e.message}`));
      });
    });
    spawnError.catch(() => {});

    let emitted = false;
    let result: StreamLine | null = null;
    let limited: StreamLine["rate_limit_info"] | null = null;

    const reading = (async () => {
      const lines = createInterface({ input: child.stdout });
      for await (const raw of lines) {
        if (!raw.trim().startsWith("{")) continue;
        let line: StreamLine;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        if (line.type === "stream_event" && line.event?.type === "content_block_delta" && line.event.delta?.type === "text_delta" && line.event.delta.text) {
          emitted = true;
          await onText(line.event.delta.text);
        } else if (line.type === "rate_limit_event" && line.rate_limit_info?.status === "rejected") {
          limited = line.rate_limit_info;
        } else if (line.type === "result") {
          result = line;
        }
      }
      const code = await new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("close", resolve)));
      return code;
    })();

    const code = await Promise.race([reading, spawnError]);
    const final = result as StreamLine | null;
    const limit = limited as StreamLine["rate_limit_info"] | null;

    if (final && !final.is_error && final.subtype === "success") {
      // 部分出力に対応していない古い CLI では最後にまとめて返す
      if (!emitted && final.result) await onText(final.result);
      return;
    }
    if (limit) {
      const when = limit.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString("ja-JP") : "しばらく後";
      throw new CliError(`Claude プランの利用上限に達しました。${when} 以降に再試行してください。`);
    }
    const message = final?.result || final?.errors?.join("\n") || stderr.trim().split("\n").slice(-3).join("\n");
    if (/log ?in|logged in|authenticat|\/login|oauth/i.test(message)) {
      throw new CliError(`Claude Code にログインしていません。ターミナルで \`claude\` を起動し、/login で Claude アカウント (Pro / Max プラン) にログインしてください。\n(${message})`);
    }
    throw new CliError(`Claude Code でエラーが発生しました${code ? ` (終了コード ${code})` : ""}: ${message || final?.subtype || "不明なエラー"}`);
  } finally {
    await fs.rm(systemFile, { force: true });
  }
}
