import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bootConfig } from "./config.ts";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
  accessedAt: string | null;
  accessCount: number;
  /** ベクトルを持っている空間の id (例: ["ja", "en"]) */
  vectorSpaces: string[];
}

interface MemoryRow {
  id: string;
  content: string;
  tags: string;
  source: string | null;
  importance: number;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
}

function rowToMemory(row: MemoryRow, vectorSpaces: string[]): Memory {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // 壊れた JSON はタグ無しとして扱う
  }
  return {
    id: row.id,
    content: row.content,
    tags,
    source: row.source,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    accessCount: row.access_count,
    vectorSpaces,
  };
}

function bufferToVector(buf: Uint8Array): Float32Array {
  // SQLite が返す view は共有バッファのことがあるのでコピーしてから解釈する
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

function vectorToBuffer(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const nowIso = () => new Date().toISOString();

export class MemoryStore {
  readonly db: DatabaseSync;
  /** spaceId -> (memoryId -> 正規化済みベクトル)。検索のたびに BLOB を読まないためのキャッシュ。 */
  private vectors = new Map<string, Map<string, Float32Array>>();

  constructor(dbPath: string = bootConfig.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.loadVectors();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT PRIMARY KEY,
        content      TEXT NOT NULL,
        tags         TEXT NOT NULL DEFAULT '[]',
        source       TEXT,
        importance   INTEGER NOT NULL DEFAULT 3,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        accessed_at  TEXT,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        space_id   TEXT NOT NULL,
        signature  TEXT NOT NULL,
        embedding  BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, space_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_space ON memory_vectors(space_id);
    `);

    // 旧スキーマ (memories.embedding に 1 本だけ持っていた頃) からの移行。
    // ベクトルは再生成できる派生データなので、列を落として作り直させる。
    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
    for (const dead of ["embedding", "embedding_model"]) {
      if (columns.some((c) => c.name === dead)) {
        try {
          this.db.exec(`ALTER TABLE memories DROP COLUMN ${dead}`);
        } catch {
          // 落とせなくても動作に影響はない (使わないだけ)
        }
      }
    }
  }

  private loadVectors(): void {
    this.vectors.clear();
    const rows = this.db
      .prepare("SELECT memory_id, space_id, embedding FROM memory_vectors")
      .all() as { memory_id: string; space_id: string; embedding: Uint8Array }[];
    for (const row of rows) {
      if (row.embedding.byteLength === 0) continue;
      let space = this.vectors.get(row.space_id);
      if (!space) {
        space = new Map();
        this.vectors.set(row.space_id, space);
      }
      space.set(row.memory_id, bufferToVector(row.embedding));
    }
  }

  /** 指定した空間の (memoryId, ベクトル) 一覧。 */
  vectorEntries(spaceId: string): [string, Float32Array][] {
    const space = this.vectors.get(spaceId);
    return space ? [...space.entries()] : [];
  }

  private spacesOf(memoryId: string): string[] {
    const out: string[] = [];
    for (const [spaceId, space] of this.vectors) if (space.has(memoryId)) out.push(spaceId);
    return out.sort();
  }

  setVector(memoryId: string, spaceId: string, signature: string, vec: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO memory_vectors (memory_id, space_id, signature, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, space_id) DO UPDATE SET
           signature = excluded.signature,
           embedding = excluded.embedding,
           created_at = excluded.created_at`,
      )
      .run(memoryId, spaceId, signature, vectorToBuffer(vec), nowIso());

    let space = this.vectors.get(spaceId);
    if (!space) {
      space = new Map();
      this.vectors.set(spaceId, space);
    }
    space.set(memoryId, vec);
  }

  clearVectors(memoryId: string): void {
    this.db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(memoryId);
    for (const space of this.vectors.values()) space.delete(memoryId);
  }

  get(id: string): Memory | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row, this.spacesOf(id)) : null;
  }

  getMany(ids: string[]): Map<string, Memory> {
    const map = new Map<string, Memory>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[];
    for (const row of rows) map.set(row.id, rowToMemory(row, this.spacesOf(row.id)));
    return map;
  }

  list(opts: { limit?: number; offset?: number; tag?: string; sort?: "recent" | "importance" | "accessed" } = {}): {
    items: Memory[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE json_each.value = ?)");
      params.push(opts.tag);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const orderSql =
      opts.sort === "importance"
        ? "ORDER BY importance DESC, updated_at DESC"
        : opts.sort === "accessed"
          ? "ORDER BY accessed_at DESC NULLS LAST, updated_at DESC"
          : "ORDER BY updated_at DESC";

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM memories ${whereSql}`).get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(`SELECT * FROM memories ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as MemoryRow[];

    return { items: rows.map((r) => rowToMemory(r, this.spacesOf(r.id))), total };
  }

  /** キーワード検索は JS 側で行うので id/content/tags だけ取る。 */
  allTextRows(): { id: string; content: string; tags: string }[] {
    return this.db.prepare("SELECT id, content, tags FROM memories").all() as {
      id: string;
      content: string;
      tags: string;
    }[];
  }

  insert(input: { content: string; tags?: string[]; source?: string | null; importance?: number }): Memory {
    const id = randomUUID();
    const ts = nowIso();
    const importance = Math.min(Math.max(Math.round(input.importance ?? 3), 1), 5);

    this.db
      .prepare(
        `INSERT INTO memories (id, content, tags, source, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.content, JSON.stringify(input.tags ?? []), input.source ?? null, importance, ts, ts);

    return this.get(id)!;
  }

  update(
    id: string,
    patch: { content?: string; tags?: string[]; importance?: number },
  ): Memory | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (patch.content !== undefined) {
      sets.push("content = ?");
      params.push(patch.content);
    }
    if (patch.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.importance !== undefined) {
      sets.push("importance = ?");
      params.push(Math.min(Math.max(Math.round(patch.importance), 1), 5));
    }
    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(nowIso(), id);

    this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    for (const space of this.vectors.values()) space.delete(id);
    return res.changes > 0;
  }

  deleteMany(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const res = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    for (const space of this.vectors.values()) for (const id of ids) space.delete(id);
    return Number(res.changes);
  }

  /** 検索でヒットした記憶の参照カウンタを更新する。 */
  touch(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
    );
    const ts = nowIso();
    for (const id of ids) stmt.run(ts, id);
  }

  /** 指定した空間で、ベクトルが無い / 署名が古い記憶の id。 */
  idsNeedingEmbedding(spaceId: string, signature: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT m.id FROM memories m
         LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.space_id = ?
         WHERE v.memory_id IS NULL OR v.signature IS NOT ?`,
      )
      .all(spaceId, signature) as { id: string }[];
    return rows.map((r) => r.id);
  }

  allIds(): string[] {
    return (this.db.prepare("SELECT id FROM memories").all() as { id: string }[]).map((r) => r.id);
  }

  countWithVector(spaceId: string, signature: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE space_id = ? AND signature = ?")
        .get(spaceId, signature) as { c: number }
    ).c;
  }

  /** 設定から消えた空間のベクトルを掃除する。 */
  pruneSpaces(keep: string[]): number {
    const rows = this.db.prepare("SELECT DISTINCT space_id FROM memory_vectors").all() as {
      space_id: string;
    }[];
    let removed = 0;
    for (const { space_id } of rows) {
      if (keep.includes(space_id)) continue;
      removed += Number(this.db.prepare("DELETE FROM memory_vectors WHERE space_id = ?").run(space_id).changes);
      this.vectors.delete(space_id);
    }
    return removed;
  }

  stats(): { total: number; tags: { tag: string; count: number }[]; oldest: string | null; newest: string | null } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    const tags = this.db
      .prepare(
        `SELECT json_each.value AS tag, COUNT(*) AS count
         FROM memories, json_each(memories.tags)
         GROUP BY json_each.value
         ORDER BY count DESC, tag ASC`,
      )
      .all() as { tag: string; count: number }[];
    const range = this.db.prepare("SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memories").get() as {
      oldest: string | null;
      newest: string | null;
    };
    return { total, tags, oldest: range.oldest, newest: range.newest };
  }

  close(): void {
    this.db.close();
  }
}
