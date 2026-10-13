# CodeMap (個人利用版)

コードの構造を地図のように可視化し、**どこから読めばいいか**を案内してくれるローカルツールです。
AI (Claude) による解説・質問応答と、セキュリティチェックも 1 つにまとめています。

[個人開発でAIコード可視化ツール「CodeMap」を作った話 (Qiita)](https://qiita.com/creolab_dev/items/427ecd0f70555d6125ba) の CodeMap と同等の機能を、
SaaS ではなく **自分の PC だけで動く個人用ツール** として作り直したものです (アカウント登録・課金・DB は不要)。

**📖 詳しい使い方は [docs/USAGE.md](docs/USAGE.md) を見てください。**

## できること

| 機能 | 内容 |
| --- | --- |
| 入力 | GitHub の URL (`https://github.com/owner/repo`、`/tree/branch/sub/dir`、`owner/repo` 形式) / ローカルフォルダのパス / ブラウザからのフォルダ選択・ドラッグ&ドロップ |
| 5 つのビュー | **フォルダ構造** (折りたたみ可能なツリー) / **依存関係** (import のグラフ、クリックで関係ファイルをハイライト) / **読む順番** (README → 設定 → エントリーポイント → 依存先 の順に番号付きで表示) / **セキュリティ** (問題のあるファイルを危険度で色分け) / **複雑度マップ** (面積=行数、色=複雑度のヒートマップ) |
| ファイル詳細 | コード表示 (検出行をハイライト)、読み込んでいる/読み込まれているファイル、外部パッケージ、関数数・複雑度 |
| AI 解説 | リポジトリ全体の解説 (技術スタック・構造・処理の流れ・おすすめの読む順番)、ファイルごとの初心者向け解説 |
| AI に質問 | リポジトリについて自由にチャット (選択中のファイルを添付可能)。回答中のファイル名はクリックで開ける |
| セキュリティ | 正規表現ベースの静的チェック 21 ルール + AI によるファイル単位のセキュリティ診断 (誤検知の判定と修正コード例) |
| 履歴 | 解析結果をローカルに保存 (最大 30 件) |

対応言語 (import 解析): TypeScript / JavaScript (Vue, Svelte, Astro 含む、tsconfig の paths エイリアス対応)、Python、Go、Rust、Java / Kotlin / Scala、Ruby、PHP、C / C++、CSS、HTML。
それ以外の言語もファイル一覧・行数・セキュリティチェックの対象になります。

## セットアップ

必要なもの: Node.js 20 以上、git (GitHub から取得する場合)

```bash
npm install
npm run build      # フロントエンドをビルド
npm start          # http://127.0.0.1:5178 を開く
```

AI 機能を使う場合は Claude API キーを設定してから起動します (未設定でも可視化とセキュリティチェックは使えます)。
`.env.example` を `.env` にコピーして書き込むか、環境変数で渡します。

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

開発時はホットリロード付きで起動できます (http://127.0.0.1:5173)。

```bash
npm run dev
```

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | なし | Claude API キー。`ant auth login` 済みのプロファイルがあればそれも使われます |
| `CODEMAP_MODEL` | `claude-opus-5-5` | AI 機能で使うモデル |
| `CODEMAP_EFFORT` | `medium` | 解説・チャットの思考量 (`low` / `medium` / `high` / `xhigh` / `max`)。全体解説とセキュリティ診断は `high` 固定 |
| `GITHUB_TOKEN` | なし | 非公開リポジトリを取得する場合に設定 |
| `PORT` | `5178` | サーバーのポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス (ローカルパスを読めるため、外部公開はしないでください) |
| `CODEMAP_DATA_DIR` | `.codemap-data` | 解析履歴の保存先 |

## プライバシー

- 解析 (依存関係・読む順番・セキュリティチェック) はすべて手元の PC で行います。
- コードが外部に送られるのは **AI 機能のボタンを押したときだけ** で、送信先は Claude API です。全体解説では README と主要ファイルの一部、ファイル解説では対象ファイルとその import 先の冒頭が送られます。
- サーバーは既定で `127.0.0.1` のみで待ち受けます。

## セキュリティチェックのルール

| 危険度 | ルール |
| --- | --- |
| 緊急 | 秘密鍵、AWS アクセスキー、既知形式の API トークン (GitHub / Slack / Stripe / OpenAI / Anthropic / Google / SendGrid) |
| 高 | パスワード等の直書き、DB 接続文字列のパスワード、`.env` のコミット、eval、コマンドインジェクション、SQL インジェクション、安全でないデシリアライズ、TLS 証明書検証の無効化、JWT 検証の不備、Supabase service_role キーのクライアント利用 |
| 中 | XSS (innerHTML / dangerouslySetInnerHTML / v-html 等)、CORS の全許可、デバッグモード、弱いハッシュ (MD5 / SHA-1)、推測可能な乱数でのトークン生成、ブラウザに公開される環境変数名に秘密情報 |
| 低 | 暗号化されていない http:// 通信、セキュリティ関連の TODO |

誤検知を抑えるため、コード系のルールはコメント行を対象外にしています (秘密情報系はコメント内も検出)。
意図的なコードは行末に `codemap-ignore`、ファイル全体なら `codemap-ignore-file` と書くと除外できます。

静的チェックは正規表現による簡易的なものです。「検出なし = 安全」ではないので、気になるファイルは AI セキュリティ診断も併用してください。

## 構成

```
server/            ローカル API サーバー (Hono)
  analyzer/        解析エンジン: ファイル収集 / import 解決 / 複雑度 / 読む順番 / セキュリティ
  ai.ts            Claude API 呼び出し (ストリーミング)
  sources.ts       GitHub (git clone --depth 1) / ローカルフォルダの読み込み
  store.ts         解析結果の保存 (gzip JSON)
shared/            サーバーとフロントエンドで共有する型・言語判定
web/               フロントエンド (React + React Flow + dagre)
tests/             解析エンジンのテスト (vitest)
```

```bash
npm test           # 解析エンジンのテスト
npm run typecheck  # 型チェック
```
