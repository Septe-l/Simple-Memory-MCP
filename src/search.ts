import { cosine, embedOne, EmbeddingError } from "./embeddings.ts";
import type { EmbeddingSpaceSettings } from "./config.ts";
import type { Memory, MemoryStore } from "./db.ts";
import type { SettingsStore } from "./settings.ts";

export interface SearchHit {
  memory: Memory;
  score: number;
  /** 空間ごとのコサイン類似度 (例: { ja: 0.72, en: 0.51 }) */
  semanticScores: Record<string, number>;
  keywordScore: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 使えなかった空間の理由。空なら全て正常。 */
  warnings: string[];
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
const CJK_GLOBAL = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;
const ALL_HIRAGANA = /^[ぁ-ゖー]+$/;
const LATIN_TOKEN = /^[\p{Script=Latin}\p{N}]+$/u;

/**
 * 英語の機能語。IDF だけだと記憶が少ないうちに落としきれないので明示的に減衰させる。
 * (日本語のひらがな bigram に対する contentWordWeight と同じ役割)
 */
const EN_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with", "from",
  "about", "into", "over", "as", "is", "am", "are", "was", "were", "be", "been", "being", "do", "does",
  "did", "have", "has", "had", "can", "could", "will", "would", "should", "may", "might", "must",
  "i", "me", "my", "you", "your", "he", "she", "it", "its", "we", "us", "our", "they", "them", "their",
  "this", "that", "these", "those", "what", "which", "who", "whom", "when", "where", "why", "how",
  "there", "here", "all", "any", "some", "no", "not", "so", "than", "then", "too", "very", "just",
  "tell", "give", "show", "know", "get", "much", "many", "does", "user",
]);

/**
 * RRF の平滑化定数。よく使われる 60 では順位差が 1% 程度しか付かず、
 * 重要度ブーストのほうが順位を支配してしまうため小さめにしている。
 */
const RRF_K = 10;

/** クエリの言語と一致しない空間に掛ける係数。 */
const OFF_LANGUAGE_WEIGHT = 0.4;

/**
 * キーワード一致とみなす下限。
 *
 * RRF は「そのリストの 1 位」に大きな加点をするため、
 * 助詞由来の bigram がたまたま 1 つ引っかかっただけの記憶でも
 * キーワード側の 1 位になって上位に飛び出してしまう。
 * 実測ではこの下限が無いと日英混在コーパスで 14/16 → 12/16 に落ちた。
 */
const KEYWORD_MIN_SCORE = 0.25;

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 日本語向けのトークナイザ。
 * 形態素解析は使わず、CJK は文字 bigram、英数字は単語に分割する。
 * (SQLite FTS5 の既定トークナイザは日本語を 1 トークンに潰してしまうため自前で行う)
 */
function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const tokens: string[] = [];
  const chunks = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  for (const chunk of chunks) {
    if (CJK.test(chunk)) {
      if (chunk.length === 1) {
        tokens.push(chunk);
      } else {
        for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
      }
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

/**
 * 「内容語らしさ」の係数。
 *
 * 日本語の bigram には「てい」「いる」「して」のような文法的な断片が、
 * 英語には the / their / about のような機能語が大量に混ざる。
 * 記憶が少ないうちは IDF だけでは落としきれないため明示的に減衰させる。
 * (「ねこ」のような平仮名の内容語も落ちるが、0 にはせず影響を残す)
 */
function contentWordWeight(token: string): number {
  if (token.length >= 2 && ALL_HIRAGANA.test(token)) return 0.25;
  if (EN_STOPWORDS.has(token)) return 0.15;
  return 1;
}

/**
 * トークンが本文に出現するか。
 *
 * CJK は bigram なので部分文字列一致でよいが、ラテン文字を部分一致させると
 * "me" が "memory" に、"cat" が "category" にヒットしてしまう。
 * ラテン文字のトークンだけ単語境界で照合する。
 */
function occursIn(token: string, haystack: string): boolean {
  if (!LATIN_TOKEN.test(token)) return haystack.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escaped}(?![\\p{Script=Latin}\\p{N}])`, "u").test(haystack);
}

/**
 * 全記憶に対するキーワード一致度 (0..1) をまとめて計算する。
 * 重みは IDF (BM25 と同じ式) × 内容語らしさ。
 */
function computeKeywordScores(query: string, docs: { id: string; text: string }[]): Map<string, number> {
  const scores = new Map<string, number>();
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0 || docs.length === 0) return scores;

  const normalized = docs.map((d) => ({ id: d.id, text: normalizeText(d.text) }));
  const total = normalized.length;

  const idf = new Map<string, number>();
  const matches = new Map<string, Set<string>>();
  for (const token of tokens) {
    const hit = new Set<string>();
    for (const doc of normalized) if (occursIn(token, doc.text)) hit.add(doc.id);
    matches.set(token, hit);
    const df = hit.size;
    idf.set(token, Math.log(1 + (total - df + 0.5) / (df + 0.5)) * contentWordWeight(token));
  }

  const totalIdf = [...idf.values()].reduce((sum, v) => sum + v, 0);
  if (totalIdf <= 0) return scores;

  const wholeQuery = normalizeText(query).trim();
  for (const doc of normalized) {
    let matched = 0;
    for (const token of tokens) if (matches.get(token)!.has(doc.id)) matched += idf.get(token)!;
    if (matched <= 0) continue;

    let score = matched / totalIdf;
    if (wholeQuery.length > 1 && doc.text.includes(wholeQuery)) score = Math.min(1, score + 0.25);
    if (score < KEYWORD_MIN_SCORE) continue;
    scores.set(doc.id, score);
  }
  return scores;
}

/**
 * 重要度による軽いブースト (1 → 0.96 倍、5 → 1.04 倍)。
 * ほぼ同点のときの並び替えに留め、関連度の順位を覆さない程度に抑える。
 */
function importanceBoost(importance: number): number {
  return 1 + 0.02 * (importance - 3);
}

/** CJK 文字が 2 割を超えていれば日本語のクエリとみなす。 */
export function detectLanguage(text: string): "ja" | "en" {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length === 0) return "en";
  const cjk = text.match(CJK_GLOBAL)?.length ?? 0;
  return cjk / letters.length > 0.2 ? "ja" : "en";
}

/**
 * クエリの言語に応じた空間の重み。
 * 多言語モデルは常に等倍。言語特化モデルは、違う言語のクエリでは
 * ノイズにしかならないので 0.4 倍に落とす。
 */
function spaceWeight(space: EmbeddingSpaceSettings, queryLanguage: "ja" | "en"): number {
  if (space.language === "multilingual") return 1;
  return space.language === queryLanguage ? 1 : OFF_LANGUAGE_WEIGHT;
}

export async function searchMemories(
  store: MemoryStore,
  settings: SettingsStore,
  opts: {
    query: string;
    limit?: number;
    tag?: string;
    minScore?: number;
    /** true なら埋め込みを使わずキーワード検索のみ */
    keywordOnly?: boolean;
  },
): Promise<SearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 100);
  const query = opts.query.trim();
  if (query === "") return { hits: [], warnings: [] };

  const config = settings.get();
  const candidateDepth = Math.max(limit * 10, 100);
  const warnings: string[] = [];

  // --- 1. キーワード検索 ---
  const keywordScores = computeKeywordScores(
    query,
    store.allTextRows().map((row) => ({ id: row.id, text: `${row.content}\n${row.tags}` })),
  );
  const keywordRanked = [...keywordScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, candidateDepth);

  // --- 2. 意味検索 (有効な空間すべて) ---
  const language = detectLanguage(query);
  const semanticScores: Record<string, Map<string, number>> = {};
  const rankedBySpace: { space: EmbeddingSpaceSettings; ranked: [string, number][] }[] = [];

  if (!opts.keywordOnly) {
    await Promise.all(
      settings.enabledSpaces().map(async (space) => {
        const entries = store.vectorEntries(space.id);
        if (entries.length === 0) return;
        try {
          const queryVec = await embedOne(space, query, "query");
          const scores = new Map<string, number>();
          for (const [id, vec] of entries) scores.set(id, cosine(queryVec, vec));
          semanticScores[space.id] = scores;
          rankedBySpace.push({
            space,
            ranked: [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, candidateDepth),
          });
        } catch (err) {
          warnings.push(
            `[${space.id}] ${err instanceof EmbeddingError ? err.message : err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  // --- 3. RRF (Reciprocal Rank Fusion) で統合 ---
  const fused = new Map<string, number>();
  let weightSum = 0;

  for (const { space, ranked } of rankedBySpace) {
    const weight = config.semanticWeight * spaceWeight(space, language);
    if (weight <= 0) continue;
    weightSum += weight;
    ranked.forEach(([id], rank) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + rank + 1));
    });
  }
  if (config.keywordWeight > 0) {
    weightSum += config.keywordWeight;
    keywordRanked.forEach(([id], rank) => {
      fused.set(id, (fused.get(id) ?? 0) + config.keywordWeight / (RRF_K + rank + 1));
    });
  }

  if (fused.size === 0) return { hits: [], warnings };

  // すべての情報源で 1 位になった場合を 1.0 とする正規化係数
  const normalizer = weightSum > 0 ? weightSum / (RRF_K + 1) : 1;

  const ids = [...fused.keys()];
  const memories = store.getMany(ids);

  let hits: SearchHit[] = ids
    .map((id) => {
      const memory = memories.get(id);
      if (!memory) return null;
      if (opts.tag && !memory.tags.includes(opts.tag)) return null;

      const perSpace: Record<string, number> = {};
      for (const [spaceId, scores] of Object.entries(semanticScores)) {
        const value = scores.get(id);
        if (value !== undefined) perSpace[spaceId] = value;
      }

      return {
        memory,
        score: (fused.get(id)! * importanceBoost(memory.importance)) / normalizer,
        semanticScores: perSpace,
        keywordScore: keywordScores.get(id) ?? 0,
      } satisfies SearchHit;
    })
    .filter((h): h is SearchHit => h !== null)
    .sort((a, b) => b.score - a.score);

  if (opts.minScore != null) hits = hits.filter((h) => h.score >= opts.minScore!);

  hits = hits.slice(0, limit);
  store.touch(hits.map((h) => h.memory.id));
  return { hits, warnings };
}

/** 追加時の重複チェック用。指定した空間で最も似た既存の記憶を返す。 */
export function findMostSimilar(
  store: MemoryStore,
  spaceId: string,
  vec: Float32Array,
): { id: string; similarity: number } | null {
  let best: { id: string; similarity: number } | null = null;
  for (const [id, other] of store.vectorEntries(spaceId)) {
    const sim = cosine(vec, other);
    if (!best || sim > best.similarity) best = { id, similarity: sim };
  }
  return best;
}
