import { spaceSignature, type EmbeddingSpaceSettings } from "./config.ts";
import type { Memory, MemoryStore } from "./db.ts";
import { embedBatch, embedOne } from "./embeddings.ts";
import { findMostSimilar } from "./search.ts";
import type { SettingsStore } from "./settings.ts";

/** これ以上似ていたら「ほぼ同じ記憶」とみなす閾値 */
export const DUPLICATE_THRESHOLD = 0.95;

export interface AddResult {
  memory: Memory;
  /** 既存のほぼ同じ記憶が見つかり、新規作成をスキップした場合に入る */
  duplicateOf: { id: string; similarity: number } | null;
  /** ベクトルを作れなかった空間の警告 */
  warnings: string[];
}

/**
 * 有効な全空間で 1 件のテキストを埋め込む。
 * 空間ごとにベクトル空間が違うので、同じ本文でも別々に作る必要がある。
 */
async function embedForAllSpaces(
  settings: SettingsStore,
  text: string,
): Promise<{ vectors: Map<string, Float32Array>; warnings: string[] }> {
  const vectors = new Map<string, Float32Array>();
  const warnings: string[] = [];

  await Promise.all(
    settings.enabledSpaces().map(async (space) => {
      try {
        vectors.set(space.id, await embedOne(space, text, "document"));
      } catch (err) {
        warnings.push(`[${space.id}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return { vectors, warnings };
}

function persistVectors(
  store: MemoryStore,
  settings: SettingsStore,
  memoryId: string,
  vectors: Map<string, Float32Array>,
): void {
  for (const space of settings.enabledSpaces()) {
    const vec = vectors.get(space.id);
    if (vec) store.setVector(memoryId, space.id, spaceSignature(space), vec);
  }
}

export async function addMemory(
  store: MemoryStore,
  settings: SettingsStore,
  input: {
    content: string;
    tags?: string[];
    importance?: number;
    source?: string | null;
    dedupe?: boolean;
  },
): Promise<AddResult> {
  const content = input.content.trim();
  if (content === "") throw new Error("content が空です。");

  const { vectors, warnings } = await embedForAllSpaces(settings, content);

  // 重複判定は、ベクトルが取れた空間のうち最も類似度が高いものを使う
  if (vectors.size > 0 && input.dedupe !== false) {
    let best: { id: string; similarity: number } | null = null;
    for (const [spaceId, vec] of vectors) {
      const candidate = findMostSimilar(store, spaceId, vec);
      if (candidate && (!best || candidate.similarity > best.similarity)) best = candidate;
    }

    if (best && best.similarity >= DUPLICATE_THRESHOLD) {
      const existing = store.get(best.id);
      if (existing) {
        // タグだけはマージして情報を落とさないようにする
        const mergedTags = [...new Set([...existing.tags, ...(input.tags ?? [])])];
        const updated =
          mergedTags.length !== existing.tags.length ? store.update(existing.id, { tags: mergedTags }) : existing;
        return { memory: updated ?? existing, duplicateOf: best, warnings };
      }
    }
  }

  const memory = store.insert({
    content,
    tags: input.tags ?? [],
    importance: input.importance,
    source: input.source ?? null,
  });
  persistVectors(store, settings, memory.id, vectors);

  return { memory: store.get(memory.id) ?? memory, duplicateOf: null, warnings };
}

export async function updateMemory(
  store: MemoryStore,
  settings: SettingsStore,
  id: string,
  patch: { content?: string; tags?: string[]; importance?: number },
): Promise<{ memory: Memory | null; warnings: string[] }> {
  const existing = store.get(id);
  if (!existing) return { memory: null, warnings: [] };

  const newContent = patch.content?.trim();
  const contentChanged = newContent !== undefined && newContent !== existing.content;
  if (contentChanged && newContent === "") throw new Error("content が空です。");

  let warnings: string[] = [];
  if (contentChanged) {
    const result = await embedForAllSpaces(settings, newContent!);
    warnings = result.warnings;
    // 本文が変わったら古いベクトルは無効なので一度消してから入れ直す
    store.clearVectors(id);
    persistVectors(store, settings, id, result.vectors);
  }

  const memory = store.update(id, {
    ...(newContent !== undefined ? { content: newContent } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
  });
  return { memory, warnings };
}

export interface ReindexResult {
  spaces: { id: string; model: string; processed: number; failed: number; error: string | null }[];
  prunedSpaces: number;
}

/** ベクトルが無い / 署名が古い記憶を、有効な全空間で作り直す。 */
export async function reindex(
  store: MemoryStore,
  settings: SettingsStore,
  opts: { force?: boolean; batchSize?: number } = {},
): Promise<ReindexResult> {
  const batchSize = opts.batchSize ?? 16;
  const spaces = settings.enabledSpaces();

  // 無効化された空間のベクトルは残しておいても使われないので掃除する
  const prunedSpaces = store.pruneSpaces(spaces.map((s) => s.id));

  const results = await Promise.all(
    spaces.map(async (space) => reindexSpace(store, space, batchSize, opts.force === true)),
  );
  return { spaces: results, prunedSpaces };
}

async function reindexSpace(
  store: MemoryStore,
  space: EmbeddingSpaceSettings,
  batchSize: number,
  force: boolean,
): Promise<{ id: string; model: string; processed: number; failed: number; error: string | null }> {
  const signature = spaceSignature(space);
  const ids = force ? store.allIds() : store.idsNeedingEmbedding(space.id, signature);
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const memories = store.getMany(chunk);
    const targets = chunk.map((id) => memories.get(id)).filter((m): m is Memory => m != null);
    if (targets.length === 0) continue;

    try {
      const { vectors } = await embedBatch(
        space,
        targets.map((m) => m.content),
        "document",
      );
      targets.forEach((m, idx) => {
        const vec = vectors[idx];
        if (vec) {
          store.setVector(m.id, space.id, signature, vec);
          processed++;
        } else {
          failed++;
        }
      });
    } catch (err) {
      // バックエンド側の問題なら以降も失敗するので中断して理由を返す
      return {
        id: space.id,
        model: space.model,
        processed,
        failed: failed + (ids.length - i),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { id: space.id, model: space.model, processed, failed, error: null };
}

/** 空間ごとの索引状況。WebUI と memory_stats で使う。 */
export function indexStatus(
  store: MemoryStore,
  settings: SettingsStore,
): { id: string; model: string; enabled: boolean; indexed: number; stale: number }[] {
  const total = store.allIds().length;
  return settings.get().spaces.map((space) => {
    const signature = spaceSignature(space);
    const indexed = space.enabled ? store.countWithVector(space.id, signature) : 0;
    return {
      id: space.id,
      model: space.model,
      enabled: space.enabled,
      indexed,
      stale: space.enabled ? Math.max(total - indexed, 0) : 0,
    };
  });
}
