// プロジェクト直下の .env があれば読み込む (他のモジュールより先に import すること)
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
