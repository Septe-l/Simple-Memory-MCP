import type { DatabaseSync } from "node:sqlite";
import {
  type AppSettings,
  type EmbeddingSpaceSettings,
  type SpaceId,
  type SpaceLanguage,
  MEMORY_LEVELS,
  defaultSettings,
  guessPrefixes,
} from "./config.ts";

const SETTINGS_KEY = "app_settings";

function clampWeight(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 5);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 外から来た JSON を、欠けた項目を既定値で補いながら AppSettings に整える。 */
function coerce(raw: unknown, base: AppSettings): AppSettings {
  const obj = (raw ?? {}) as Partial<AppSettings>;
  const rawSpaces = Array.isArray(obj.spaces) ? obj.spaces : [];

  const spaces = base.spaces.map((fallback) => {
    const found = rawSpaces.find((s) => (s as EmbeddingSpaceSettings | undefined)?.id === fallback.id) as
      | Partial<EmbeddingSpaceSettings>
      | undefined;
    if (!found) return fallback;

    const model = str(found.model, fallback.model).trim();
    // モデルを変えたのに接頭辞が前のモデルのままだと精度が落ちるので、
    // 接頭辞が明示されていなければ新しいモデルから推測し直す。
    const guessed = guessPrefixes(model);
    const modelChanged = model !== fallback.model;

    const language: SpaceLanguage = (["multilingual", "ja", "en"] as const).includes(found.language as SpaceLanguage)
      ? (found.language as SpaceLanguage)
      : fallback.language;

    return {
      id: fallback.id,
      language,
      enabled: typeof found.enabled === "boolean" ? found.enabled : fallback.enabled,
      baseUrl: str(found.baseUrl, fallback.baseUrl).trim().replace(/\/+$/, ""),
      apiKey: str(found.apiKey, fallback.apiKey),
      model,
      queryPrefix:
        found.queryPrefix !== undefined
          ? str(found.queryPrefix, fallback.queryPrefix)
          : modelChanged
            ? guessed.query
            : fallback.queryPrefix,
      documentPrefix:
        found.documentPrefix !== undefined
          ? str(found.documentPrefix, fallback.documentPrefix)
          : modelChanged
            ? guessed.document
            : fallback.documentPrefix,
    } satisfies EmbeddingSpaceSettings;
  });

  const level = Number(obj.memoryLevel);

  return {
    spaces,
    semanticWeight: clampWeight(obj.semanticWeight, base.semanticWeight),
    keywordWeight: clampWeight(obj.keywordWeight, base.keywordWeight),
    memoryLevel: Number.isFinite(level)
      ? Math.min(Math.max(Math.round(level), 1), MEMORY_LEVELS.length)
      : base.memoryLevel,
  };
}

/**
 * 実行時に変更できる設定。SQLite に JSON 1 行で持ち、
 * WebUI から書き換えたら即座に反映される (再起動不要)。
 */
export class SettingsStore {
  private current: AppSettings;
  private listeners: ((next: AppSettings) => void)[] = [];
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const base = defaultSettings();
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
      | { value: string }
      | undefined;

    if (row) {
      try {
        this.current = coerce(JSON.parse(row.value), base);
      } catch {
        this.current = base;
      }
    } else {
      this.current = base;
      this.persist();
    }
  }

  get(): AppSettings {
    return this.current;
  }

  space(id: SpaceId): EmbeddingSpaceSettings | undefined {
    return this.current.spaces.find((s) => s.id === id);
  }

  enabledSpaces(): EmbeddingSpaceSettings[] {
    return this.current.spaces.filter((s) => s.enabled && s.model !== "");
  }

  update(patch: unknown): AppSettings {
    this.current = coerce(patch, this.current);
    this.persist();
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  /**
   * 環境変数 (Docker Compose の設定など) の既定値に戻す。
   * 一度 WebUI で保存すると DB の値が優先されるため、
   * compose.yaml を書き換えても反映されない。その解除用。
   */
  reset(): AppSettings {
    this.current = defaultSettings();
    this.persist();
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  /** 設定が変わったら呼ばれる。ベクトルキャッシュの破棄などに使う。 */
  onChange(listener: (next: AppSettings) => void): void {
    this.listeners.push(listener);
  }

  private persist(): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(this.current), new Date().toISOString());
  }
}
