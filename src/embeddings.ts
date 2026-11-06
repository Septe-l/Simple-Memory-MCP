import type { EmbeddingSpaceSettings } from "./config.ts";

export class EmbeddingError extends Error {}

const TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 60_000);

/** ベクトルを L2 正規化する。以後の類似度計算は内積だけで済む。 */
function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

/** トークンが設定されているときだけ Authorization ヘッダを付ける。 */
export function authHeaders(apiKey: string, base: Record<string, string> = {}): Record<string, string> {
  return apiKey ? { ...base, Authorization: `Bearer ${apiKey}` } : base;
}

/**
 * HTTP エラーを、利用者が次に何をすべきか分かる文にする。
 *
 * 認証エラーのとき LM Studio は送られたトークンの一部を本文に含めて返すため、
 * 401/403 では本文をそのまま表示・ログ出力せず、種類だけを判定して伝える。
 */
export function describeHttpError(
  status: number,
  body: string,
  space: Pick<EmbeddingSpaceSettings, "apiKey" | "model" | "baseUrl">,
): string {
  if (status === 401) {
    if (!space.apiKey || /none was provided|required/i.test(body)) {
      return `認証が必要です (HTTP 401)。${space.baseUrl} は API トークンを要求しています。設定画面で API トークンを入力してください。`;
    }
    if (/malformed/i.test(body)) {
      return "API トークンの形式が正しくありません (HTTP 401)。LM Studio で発行したトークンを、前後の空白を含めずにそのまま貼り付けてください。";
    }
    // 実際にあった: 前半の識別子の 1 文字だけ大文字小文字が違い、後半は合っていた。
    // LM Studio はその場合も「形式不正」ではなく「無効」と返す。
    return "API トークンが無効です (HTTP 401)。失効していないか、別のサーバー用のトークンでないか、大文字・小文字の違いも含めて発行されたものと一字ずつ一致しているかを確認してください。";
  }
  if (status === 403) {
    return "API トークンにこの操作の権限がありません (HTTP 403)。LM Studio でトークンの権限設定を確認してください。";
  }
  return `埋め込みの生成に失敗しました (HTTP ${status})。モデル "${space.model}" が読み込まれているか確認してください。${body.slice(0, 300)}`;
}

/** 記憶を保存するとき (document) と検索するとき (query) で接頭辞が変わる。 */
export type EmbedKind = "query" | "document";

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
  model?: string;
}

/**
 * OpenAI 互換の /embeddings を叩いて正規化済みベクトルを返す。
 * LM Studio でも llama.cpp の llama-server でも同じ形で使える。
 */
export async function embedBatch(
  space: EmbeddingSpaceSettings,
  texts: string[],
  kind: EmbedKind,
): Promise<{ vectors: Float32Array[]; servedModel: string | null }> {
  if (texts.length === 0) return { vectors: [], servedModel: null };

  const prefix = kind === "query" ? space.queryPrefix : space.documentPrefix;
  const input = prefix ? texts.map((t) => prefix + t) : texts;

  const res = await fetch(`${space.baseUrl}/embeddings`, {
    method: "POST",
    headers: authHeaders(space.apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ model: space.model, input }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new EmbeddingError(
      `${space.baseUrl} に接続できません: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbeddingError(describeHttpError(res.status, body, space));
  }

  const json = (await res.json()) as EmbeddingResponse;
  const rows = json.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new EmbeddingError("埋め込み API のレスポンス形式が想定と異なります。");
  }

  const vectors = new Array<Float32Array>(texts.length);
  rows.forEach((row, i) => {
    const idx = typeof row.index === "number" ? row.index : i;
    if (!Array.isArray(row.embedding)) throw new EmbeddingError("embedding フィールドがありません。");
    vectors[idx] = normalize(row.embedding);
  });

  return { vectors, servedModel: typeof json.model === "string" ? json.model : null };
}

export async function embedOne(
  space: EmbeddingSpaceSettings,
  text: string,
  kind: EmbedKind,
): Promise<Float32Array> {
  const { vectors } = await embedBatch(space, [text], kind);
  if (!vectors[0]) throw new EmbeddingError("埋め込みを取得できませんでした。");
  return vectors[0];
}

/** 正規化済みベクトル同士のコサイン類似度 (= 内積)。次元が違う場合は 0。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export interface SpaceHealth {
  id: string;
  enabled: boolean;
  ok: boolean;
  model: string;
  baseUrl: string;
  dimensions: number | null;
  /** サーバーが実際に使ったモデル名。要求と違えば警告になる。 */
  servedModel: string | null;
  /** 要求したモデルと違うモデルで応答された (= 指定が無視されている) */
  modelMismatch: boolean;
  detail: string;
}

/**
 * 埋め込みバックエンドの疎通確認。
 *
 * 単に繋がるかだけでなく「要求したモデルが本当に使われたか」も見る。
 * LM Studio は要求されたモデルが埋め込みモデルとして認識されていない場合、
 * エラーを返さずに別のロード済みモデルのベクトルを返してくることがあり、
 * 気付かないまま全く別のモデルで索引を作ってしまうため。
 */
export async function checkSpace(space: EmbeddingSpaceSettings): Promise<SpaceHealth> {
  const base: SpaceHealth = {
    id: space.id,
    enabled: space.enabled,
    ok: false,
    model: space.model,
    baseUrl: space.baseUrl,
    dimensions: null,
    servedModel: null,
    modelMismatch: false,
    detail: "",
  };

  if (!space.enabled) return { ...base, detail: "無効化されています" };
  if (space.model.trim() === "") return { ...base, detail: "モデルが指定されていません" };

  try {
    const { vectors, servedModel } = await embedBatch(space, ["接続テスト / connection test"], "query");
    const dimensions = vectors[0]?.length ?? null;
    const mismatch = servedModel != null && servedModel !== space.model;
    return {
      ...base,
      ok: !mismatch,
      dimensions,
      servedModel,
      modelMismatch: mismatch,
      detail: mismatch
        ? `"${space.model}" を要求しましたが、サーバーは "${servedModel}" で応答しました。指定したモデルが埋め込みモデルとして認識されていない可能性があります。`
        : `${dimensions} 次元`,
    };
  } catch (err) {
    return { ...base, detail: err instanceof Error ? err.message : String(err) };
  }
}
