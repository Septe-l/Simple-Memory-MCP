import { Router } from "express";
import { z } from "zod";
import { bootConfig, guessPrefixes, MEMORY_LEVELS, memoryLevelInfo, recommendedSystemPrompt } from "./config.ts";
import type { MemoryStore } from "./db.ts";
import { checkSpace } from "./embeddings.ts";
import { searchMemories } from "./search.ts";
import { addMemory, indexStatus, reindex, updateMemory } from "./service.ts";
import type { SettingsStore } from "./settings.ts";

const createSchema = z.object({
  content: z.string().min(1, "内容を入力してください"),
  tags: z.array(z.string()).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  dedupe: z.boolean().optional(),
});

const patchSchema = z.object({
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

const idsSchema = z.object({ ids: z.array(z.string()).min(1) });

const spaceSchema = z.object({
  id: z.enum(["primary", "secondary"]),
  language: z.enum(["multilingual", "ja", "en"]).optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  queryPrefix: z.string().optional(),
  documentPrefix: z.string().optional(),
});

const settingsSchema = z.object({
  spaces: z.array(spaceSchema).optional(),
  semanticWeight: z.number().min(0).max(5).optional(),
  keywordWeight: z.number().min(0).max(5).optional(),
  memoryLevel: z.number().int().min(1).max(MEMORY_LEVELS.length).optional(),
});

function intParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function createApiRouter(store: MemoryStore, settings: SettingsStore): Router {
  const router = Router();

  /* ---------- 設定 ---------- */

  router.get("/settings", (_req, res) => {
    res.json({
      settings: settings.get(),
      index: indexStatus(store, settings),
      memoryLevels: MEMORY_LEVELS,
      systemPrompt: recommendedSystemPrompt(memoryLevelInfo(settings.get().memoryLevel)),
    });
  });

  router.put("/settings", (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const next = settings.update(parsed.data);
    res.json({
      settings: next,
      index: indexStatus(store, settings),
      systemPrompt: recommendedSystemPrompt(memoryLevelInfo(next.memoryLevel)),
    });
  });

  /** 環境変数の既定値に戻す (Docker Compose の設定を効かせ直すとき用)。 */
  router.post("/settings/reset", (_req, res) => {
    const next = settings.reset();
    res.json({
      settings: next,
      index: indexStatus(store, settings),
      systemPrompt: recommendedSystemPrompt(memoryLevelInfo(next.memoryLevel)),
    });
  });

  /** 保存せずに指定内容で疎通確認する。設定画面の「接続テスト」用。 */
  router.post("/settings/test", async (req, res) => {
    const parsed = spaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const current = settings.space(parsed.data.id);
    if (!current) {
      res.status(404).json({ error: "その空間はありません" });
      return;
    }
    res.json(
      await checkSpace({
        ...current,
        ...parsed.data,
        enabled: true,
        baseUrl: (parsed.data.baseUrl ?? current.baseUrl).replace(/\/+$/, ""),
      }),
    );
  });

  /** モデル名から推奨の接頭辞を返す。設定画面の入力補助用。 */
  router.get("/settings/prefixes", (req, res) => {
    res.json(guessPrefixes(String(req.query.model ?? "")));
  });

  /** バックエンドが提供しているモデル一覧 (OpenAI 互換の /models)。 */
  router.get("/settings/models", async (req, res) => {
    const baseUrl = String(req.query.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      res.status(400).json({ error: "baseUrl が必要です" });
      return;
    }
    try {
      const upstream = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok) {
        res.status(502).json({ error: `HTTP ${upstream.status}` });
        return;
      }
      const json = (await upstream.json()) as { data?: { id?: string }[] };
      res.json({ models: (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ---------- 状態 ---------- */

  router.get("/health", async (_req, res) => {
    const spaces = await Promise.all(settings.get().spaces.map((space) => checkSpace(space)));
    res.json({
      ok: true,
      spaces,
      index: indexStatus(store, settings),
      dbPath: bootConfig.dbPath,
    });
  });

  router.get("/stats", (_req, res) => {
    res.json({ ...store.stats(), index: indexStatus(store, settings) });
  });

  /* ---------- 記憶 ---------- */

  // 検索 (q あり) と一覧 (q なし) を兼ねる
  router.get("/memories", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string" && req.query.tag !== "" ? req.query.tag : undefined;
    const limit = intParam(req.query.limit, q ? 20 : 50);
    const offset = intParam(req.query.offset, 0);
    const sort = ["recent", "importance", "accessed"].includes(String(req.query.sort))
      ? (req.query.sort as "recent" | "importance" | "accessed")
      : "recent";

    if (q === "") {
      const { items, total } = store.list({ limit, offset, tag, sort });
      res.json({ mode: "list", total, items: items.map((m) => ({ ...m, score: null })), warnings: [] });
      return;
    }

    const result = await searchMemories(store, settings, { query: q, limit, tag });
    res.json({
      mode: "search",
      total: result.hits.length,
      items: result.hits.map((h) => ({
        ...h.memory,
        score: h.score,
        semanticScores: h.semanticScores,
        keywordScore: h.keywordScore,
      })),
      warnings: result.warnings,
    });
  });

  router.get("/memories/:id", (req, res) => {
    const memory = store.get(req.params.id);
    if (!memory) {
      res.status(404).json({ error: "記憶が見つかりません" });
      return;
    }
    res.json(memory);
  });

  router.post("/memories", async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const result = await addMemory(store, settings, { ...parsed.data, source: "web" });
    res.status(result.duplicateOf ? 200 : 201).json({
      memory: result.memory,
      duplicateOf: result.duplicateOf,
      warnings: result.warnings,
    });
  });

  router.patch("/memories/:id", async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const result = await updateMemory(store, settings, req.params.id, parsed.data);
    if (!result.memory) {
      res.status(404).json({ error: "記憶が見つかりません" });
      return;
    }
    res.json({ memory: result.memory, warnings: result.warnings });
  });

  router.delete("/memories/:id", (req, res) => {
    if (!store.delete(req.params.id)) {
      res.status(404).json({ error: "記憶が見つかりません" });
      return;
    }
    res.json({ deleted: 1 });
  });

  router.post("/memories/bulk-delete", (req, res) => {
    const parsed = idsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    res.json({ deleted: store.deleteMany(parsed.data.ids) });
  });

  router.post("/reindex", async (req, res) => {
    res.json(await reindex(store, settings, { force: req.body?.force === true }));
  });

  return router;
}
