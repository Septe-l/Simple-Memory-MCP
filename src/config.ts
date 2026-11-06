import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** バージョンは package.json だけを正とし、二重管理でずれないようにする。 */
export const appVersion: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(rootDir, p);
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 起動時に決まる設定。ここは WebUI からは変更できない。 */
export const bootConfig = {
  host: process.env.MEMORY_MCP_HOST ?? "0.0.0.0",
  port: num(process.env.MEMORY_MCP_PORT, 8080),
  dbPath: resolveFromRoot(process.env.MEMORY_DB_PATH ?? "data/memory.db"),
  publicDir: path.join(rootDir, "public"),
} as const;

/** WebUI のパス。`/` はここへリダイレクトする。 */
export const WEBUI_PATH = "/webui";

/**
 * 埋め込みモデルごとに必要な接頭辞のプリセット。
 * これを付けないと検索精度が大きく落ちるモデルがある。
 */
const PREFIX_PRESETS: { match: RegExp; query: string; document: string }[] = [
  { match: /ruri/i, query: "検索クエリ: ", document: "検索文書: " },
  { match: /nomic-embed/i, query: "search_query: ", document: "search_document: " },
  { match: /(^|[-_/])e5([-_]|$)|multilingual-e5/i, query: "query: ", document: "passage: " },
  { match: /bge-m3/i, query: "", document: "" },
];

export function guessPrefixes(model: string): { query: string; document: string } {
  const hit = PREFIX_PRESETS.find((p) => p.match.test(model));
  return hit ? { query: hit.query, document: hit.document } : { query: "", document: "" };
}

export type SpaceId = "primary" | "secondary";
/** 多言語モデルなら "multilingual"。言語特化モデルはその言語を指定する。 */
export type SpaceLanguage = "multilingual" | "ja" | "en";

export interface EmbeddingSpaceSettings {
  /** 空間の識別子。ベクトルはこの単位で別々に保存・検索される。 */
  id: SpaceId;
  /**
   * この空間のモデルが得意な言語。
   * "multilingual" 以外を指定すると、クエリの言語が違うときに重みが下がる。
   */
  language: SpaceLanguage;
  enabled: boolean;
  /** OpenAI 互換の埋め込みエンドポイントのベース URL */
  baseUrl: string;
  apiKey: string;
  model: string;
  queryPrefix: string;
  documentPrefix: string;
}

export interface AppSettings {
  spaces: EmbeddingSpaceSettings[];
  semanticWeight: number;
  keywordWeight: number;
  /** 会話内容をどこまで記憶するか (1: 重要な話題のみ 〜 5: 細かいことまで) */
  memoryLevel: number;
}

export interface MemoryLevelInfo {
  level: number;
  label: string;
  /** これ未満の重要度は MCP 経由では保存しない */
  minImportance: number;
  /** モデルに伝える「何を保存すべきか」の指針 */
  guidance: string;
}

/**
 * 記憶レベルの定義。
 *
 * 何を記憶するかを最終的に決めるのは LLM なので、この設定は
 * (1) MCP のツール説明文を段階に応じて書き換えてモデルの判断を誘導する
 * (2) 閾値を下回る重要度の memory_add を実際に拒否する
 * の 2 段構えで効かせている。
 */
export const MEMORY_LEVELS: MemoryLevelInfo[] = [
  {
    level: 1,
    label: "核心のみ",
    minImportance: 5,
    guidance:
      "長期にわたって変わらない核心的な事実だけを保存してください (名前・家族構成・恒久的な好み・重大な決定など)。それ以外は保存しないでください。",
  },
  {
    level: 2,
    label: "重要なことだけ",
    minImportance: 4,
    guidance:
      "重要な事実だけを保存してください (核心的な事実に加え、継続している仕事・趣味・はっきりした選好など)。一時的な話題は保存しないでください。",
  },
  {
    level: 3,
    label: "標準",
    minImportance: 3,
    guidance:
      "後の会話で役立つ具体的な事実を保存してください (好み・決定事項・進行中の作業・環境など)。その場限りの内容や、すぐ古くなる情報は保存しないでください。",
  },
  {
    level: 4,
    label: "細かめ",
    minImportance: 2,
    guidance:
      "後の会話で役立ちそうな内容は積極的に保存してください。細かい好みや一時的な状況も、覚えておくと会話が自然になるものは保存して構いません。",
  },
  {
    level: 5,
    label: "ほぼ全部",
    minImportance: 1,
    guidance:
      "会話に出てきたユーザーに関する事実は、細かいことでも幅広く保存してください。些細な発言でも後で参照できるように残します。",
  },
];

/**
 * LM Studio の System Prompt に貼るための推奨文。
 *
 * MCP の instructions やツール説明文を読まずにツールを呼ばないモデルが多いため、
 * 最終的にはこれを貼ってもらうのが最も確実。記憶レベルの設定を反映させる。
 */
export function recommendedSystemPrompt(level: MemoryLevelInfo): string {
  return [
    "あなたは memory ツールで、ユーザーに関する長期記憶にアクセスできます。",
    "",
    "【記憶の参照】",
    "- 会話の最初のユーザー発言に対して、必ず memory_search を呼んでください。引数なしで呼べば重要な記憶がまとめて返ります。",
    "- ユーザー自身に少しでも関わる話題（好み・持ち物・家族・仕事・環境・予定・過去の会話）では、答える前に必ず memory_search を呼んでください。",
    "- 「覚えてる?」「前に言った」「いつもの」「私の」などの表現が出たら必ず memory_search を呼んでください。",
    "- 検索で得た記憶は確定した事実として扱い、回答に反映してください。記憶にあることを推測で言い換えないでください。",
    "- 検索した結果が空だったときだけ「わからない」と答えてください。検索せずに知らないと答えてはいけません。",
    "",
    "【記憶の保存】",
    `- ${level.guidance}`,
    "- 保存するときは、後から読んで意味が分かる完結した文にしてください（例:「ユーザーは Python より TypeScript を好む」）。",
    "- 事実が変わったときは memory_add ではなく memory_update で書き換えてください。",
  ].join("\n");
}

export function memoryLevelInfo(level: number): MemoryLevelInfo {
  const clamped = Math.min(Math.max(Math.round(level), 1), MEMORY_LEVELS.length);
  return MEMORY_LEVELS[clamped - 1]!;
}

/**
 * OpenAI 互換 API のベース URL に揃える。
 *
 * `/v1` を付け忘れると LM Studio は存在しないパスにも「トークンが無効」と 401 を返し、
 * 認証の問題と見分けがつかなくなるので補う。llama-server も同じ `/v1` 配下で動く。
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/.test(url)) url = `${url}/v1`;
  return url;
}

const defaultBaseUrl = normalizeBaseUrl(process.env.EMBEDDING_BASE_URL ?? "http://localhost:1234/v1");
/**
 * 埋め込みサーバーの API トークン。空なら Authorization ヘッダを送らない。
 * LM Studio で「API トークンを要求する」設定を有効にしている場合に必要。
 */
const defaultApiKey = (process.env.EMBEDDING_API_KEY ?? "").trim();

function spaceFromEnv(
  id: SpaceId,
  defaults: { enabled: boolean; model: string; language: SpaceLanguage },
): EmbeddingSpaceSettings {
  const upper = id.toUpperCase();
  const model = process.env[`EMBEDDING_${upper}_MODEL`] ?? defaults.model;
  const guessed = guessPrefixes(model);
  const language = process.env[`EMBEDDING_${upper}_LANGUAGE`] ?? defaults.language;
  return {
    id,
    language: (["multilingual", "ja", "en"].includes(language) ? language : defaults.language) as SpaceLanguage,
    enabled: (process.env[`EMBEDDING_${upper}_ENABLED`] ?? String(defaults.enabled)) !== "false",
    baseUrl: normalizeBaseUrl(process.env[`EMBEDDING_${upper}_BASE_URL`] ?? defaultBaseUrl),
    apiKey: (process.env[`EMBEDDING_${upper}_API_KEY`] ?? defaultApiKey).trim(),
    model,
    queryPrefix: process.env[`EMBEDDING_${upper}_QUERY_PREFIX`] ?? guessed.query,
    documentPrefix: process.env[`EMBEDDING_${upper}_DOCUMENT_PREFIX`] ?? guessed.document,
  };
}

/**
 * DB に保存された設定が無いときの初期値。
 *
 * 主空間は多言語モデル 1 つ。実測では、これに英語専用モデルを足すと
 * 日英混在の記憶に対する正解率がむしろ下がった (14/16 → 10/16) ため、
 * 副空間は既定で無効にしてある。言語特化モデルを別マシンで動かしたいときに使う。
 */
export function defaultSettings(): AppSettings {
  return {
    spaces: [
      spaceFromEnv("primary", {
        enabled: true,
        model: "text-embedding-multilingual-e5-large-instruct",
        language: "multilingual",
      }),
      spaceFromEnv("secondary", {
        enabled: false,
        model: "text-embedding-nomic-embed-text-v1.5",
        language: "en",
      }),
    ],
    semanticWeight: num(process.env.SEMANTIC_WEIGHT, 1.0),
    keywordWeight: num(process.env.KEYWORD_WEIGHT, 1.0),
    memoryLevel: num(process.env.MEMORY_LEVEL, 3),
  };
}

/**
 * 保存済みベクトルが今の設定で作られたかを判定する署名。
 * モデルか文書側の接頭辞を変えると値が変わり、再生成の対象になる。
 */
export function spaceSignature(space: EmbeddingSpaceSettings): string {
  return `${space.model}|${space.documentPrefix}`;
}
