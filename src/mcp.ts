import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MEMORY_LEVELS, memoryLevelInfo } from "./config.ts";
import type { Memory, MemoryStore } from "./db.ts";
import { searchMemories } from "./search.ts";
import { addMemory, indexStatus, reindex, updateMemory } from "./service.ts";
import type { SettingsStore } from "./settings.ts";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

function formatMemory(m: Memory, extra?: string): string {
  const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
  const head = `- id: ${m.id}${extra ? ` (${extra})` : ""}`;
  return `${head}\n  重要度: ${m.importance}/5${tags}  更新: ${m.updatedAt}\n  ${m.content.replace(/\n/g, "\n  ")}`;
}

export function createMcpServer(store: MemoryStore, settings: SettingsStore): McpServer {
  // サーバーはリクエストごとに作り直されるので、ここで読めば常に最新の設定になる
  const level = memoryLevelInfo(settings.get().memoryLevel);

  const server = new McpServer(
    { name: "simple-memory-mcp", version: "2.1.0" },
    {
      instructions: [
        "ユーザーに関する長期記憶を保存・検索するサーバーです。日本語と英語の両方に対応しています。",
        "",
        "【最重要】回答する前に必ず memory_search を呼んでください。",
        "- 会話の最初のユーザー発言には、必ず memory_search を呼んでください。引数なしで呼べば重要な記憶がまとめて返ります。",
        "- ユーザー自身に少しでも関わる話題（好み・持ち物・家族・仕事・環境・予定・過去の会話）では、答える前に必ず memory_search を呼んでください。",
        "- 「覚えてる?」「前に言った」「いつもの」「私の」などの表現が出たら必ず memory_search を呼んでください。",
        "- 検索で得た記憶は事実として扱い、回答に反映してください。記憶にあることを推測で答え直さないでください。",
        "- 検索した結果が空だったときだけ「わからない」と答えてください。検索せずに知らないと答えてはいけません。",
        "",
        `【記憶の保存】現在の設定: ${level.label} (レベル ${level.level}/${MEMORY_LEVELS.length})`,
        level.guidance,
        `重要度が ${level.minImportance} 未満の記憶はこの設定では保存されません。`,
      ].join("\n"),
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "記憶を検索",
      description: [
        "ユーザーに関する長期記憶を検索します (意味検索 + キーワード検索のハイブリッド、日英対応)。",
        "回答する前に必ず呼んでください。特に次の場合は必須です:",
        "・会話の最初のユーザー発言",
        "・ユーザー自身の好み / 持ち物 / 家族 / 仕事 / 環境 / 予定に関わる話題",
        "・「覚えてる?」「前に言った」「いつもの」「私の」などの表現が出たとき",
        "query を省略すると重要な記憶がまとめて返るので、何を検索すべきか迷ったら引数なしで呼んでください。",
        "検索せずに「わからない」と答えてはいけません。",
        "/ Search long-term memory about the user. Call this before answering.",
      ].join("\n"),
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("検索したい内容。自然文でよい (例: 好きなプログラミング言語)。省略すると重要な記憶を新しい順に返す"),
        limit: z.number().int().min(1).max(50).optional().describe("取得件数 (既定 8、query 省略時は 20)"),
        tag: z.string().optional().describe("このタグを持つ記憶だけに絞り込む"),
      },
    },
    async ({ query, limit, tag }) => {
      const trimmed = query?.trim() ?? "";

      // query 省略時は「まず呼ばせる」ための入り口。重要度→新しさの順にまとめて返す。
      if (trimmed === "") {
        const { items, total } = store.list({ limit: limit ?? 20, tag, sort: "importance" });
        if (items.length === 0) return text("保存されている記憶はまだありません。");
        return text(
          `保存されている記憶 ${total} 件のうち ${items.length} 件 (重要度順):\n${items.map((m) => formatMemory(m)).join("\n")}`,
        );
      }

      const result = await searchMemories(store, settings, { query: trimmed, limit, tag });
      const note = result.warnings.length > 0 ? `\n\n(注意: ${result.warnings.join(" / ")})` : "";

      if (result.hits.length === 0) {
        // 完全に空で返すとモデルが「記憶が無い」と誤解しやすいので、
        // 記憶自体は存在することと、その一部を必ず添える。
        const { items, total } = store.list({ limit: 10, sort: "importance" });
        if (total === 0) return text(`保存されている記憶はまだありません。${note}`);
        return text(
          [
            `「${trimmed}」に直接一致する記憶はありませんでした。`,
            `ただし記憶は全部で ${total} 件あります。関連しそうなものを重要度順に挙げます:`,
            items.map((m) => formatMemory(m)).join("\n"),
            note,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const body = result.hits.map((h) => formatMemory(h.memory, `関連度 ${h.score.toFixed(3)}`)).join("\n");
      return text(
        `${result.hits.length} 件の記憶が見つかりました。これらは確定した事実として扱ってください:\n${body}${note}`,
      );
    },
  );

  server.registerTool(
    "memory_add",
    {
      title: "記憶を追加",
      description: [
        "後の会話でも役立つ情報を長期記憶に保存します。1 つの記憶には 1 つの事実を、文脈が分かる完結した文で書いてください。",
        `現在の記憶レベルは「${level.label}」です。${level.guidance}`,
        `重要度 ${level.minImportance} 未満を指定した場合は保存されません。`,
        "/ Store a durable fact about the user.",
      ].join("\n"),
      inputSchema: {
        content: z
          .string()
          .min(1)
          .describe("記憶する内容。後から読んで意味が分かる完結した文で書く (例: ユーザーは Python より TypeScript を好む)"),
        tags: z.array(z.string()).optional().describe('分類用タグ (例: ["好み", "開発"])'),
        importance: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            `重要度 1-5 (既定 3)。検索順位に軽く影響する。現在の設定では ${level.minImportance} 以上のものだけが保存される`,
          ),
      },
    },
    async ({ content, tags, importance }) => {
      const effectiveImportance = importance ?? 3;
      if (effectiveImportance < level.minImportance) {
        return text(
          [
            `保存しませんでした。現在の記憶レベル「${level.label}」では重要度 ${level.minImportance} 以上のものだけを保存します (指定された重要度: ${effectiveImportance})。`,
            level.guidance,
            "本当に残すべき内容なら、重要度を上げ直して呼び直してください。",
          ].join("\n"),
        );
      }
      try {
        const res = await addMemory(store, settings, { content, tags, importance, source: "mcp" });
        const lines: string[] = [];
        lines.push(
          res.duplicateOf
            ? `ほぼ同じ記憶が既にあったため保存をスキップしました (類似度 ${res.duplicateOf.similarity.toFixed(3)})。`
            : "記憶を保存しました。",
        );
        lines.push(formatMemory(res.memory));
        for (const warning of res.warnings) lines.push(`警告: ${warning}`);
        return text(lines.join("\n"));
      } catch (err) {
        return fail(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "記憶を更新",
      description:
        "既存の記憶を書き換えます。事実が変わったときは新規追加ではなく更新してください。/ Update an existing memory in place.",
      inputSchema: {
        id: z.string().describe("更新する記憶の id (memory_search / memory_list で得られる)"),
        content: z.string().optional().describe("新しい内容"),
        tags: z.array(z.string()).optional().describe("新しいタグ (指定すると全置換)"),
        importance: z.number().int().min(1).max(5).optional().describe("新しい重要度 1-5"),
      },
    },
    async ({ id, content, tags, importance }) => {
      try {
        const res = await updateMemory(store, settings, id, { content, tags, importance });
        if (!res.memory) return fail(`id ${id} の記憶は見つかりませんでした。`);
        const warn = res.warnings.length > 0 ? `\n警告: ${res.warnings.join(" / ")}` : "";
        return text(`記憶を更新しました。\n${formatMemory(res.memory)}${warn}`);
      } catch (err) {
        return fail(`更新に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      title: "記憶を削除",
      description:
        "指定した id の記憶を削除します。削除は取り消せないため、ユーザーが明示的に忘れてほしいと言った場合や、明らかに誤った記憶の場合にのみ使ってください。/ Delete memories by id.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("削除する記憶の id の配列"),
      },
    },
    async ({ ids }) => {
      const found = store.getMany(ids);
      const deleted = store.deleteMany(ids);
      const missing = ids.filter((id) => !found.has(id));
      const lines = [`${deleted} 件の記憶を削除しました。`];
      if (missing.length > 0) lines.push(`見つからなかった id: ${missing.join(", ")}`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "記憶の一覧",
      description:
        "保存されている記憶を新しい順に一覧します。検索語が思いつかないとき、記憶全体を見渡したいときに使ってください。/ List stored memories.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("取得件数 (既定 20)"),
        offset: z.number().int().min(0).optional().describe("スキップ件数 (ページング用)"),
        tag: z.string().optional().describe("このタグを持つ記憶だけに絞り込む"),
      },
    },
    async ({ limit, offset, tag }) => {
      const { items, total } = store.list({ limit: limit ?? 20, offset, tag });
      if (items.length === 0) return text("記憶はまだありません。");
      return text(`全 ${total} 件中 ${items.length} 件:\n${items.map((m) => formatMemory(m)).join("\n")}`);
    },
  );

  server.registerTool(
    "memory_stats",
    {
      title: "記憶の統計",
      description: "保存件数・タグの内訳・索引の状態を返します。/ Summary of what is stored.",
      inputSchema: {},
    },
    async () => {
      const s = store.stats();
      const index = indexStatus(store, settings);
      const tagLine = s.tags.length > 0 ? s.tags.map((t) => `${t.tag} (${t.count})`).join(", ") : "(タグなし)";
      const indexLines = index.map(
        (i) =>
          `  - ${i.id} (${i.model}): ${i.enabled ? `索引済み ${i.indexed} 件 / 未索引 ${i.stale} 件` : "無効"}`,
      );
      return text(
        [
          `記憶の総数: ${s.total} 件`,
          `最古: ${s.oldest ?? "-"} / 最新: ${s.newest ?? "-"}`,
          `タグ: ${tagLine}`,
          `記憶レベル: ${level.label} (${level.level}/${MEMORY_LEVELS.length}) — 重要度 ${level.minImportance} 以上を保存`,
          "ベクトル空間:",
          ...indexLines,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "memory_reindex",
    {
      title: "埋め込みの再生成",
      description:
        "ベクトルが未生成、または別モデルで作られた記憶の埋め込みを作り直します。埋め込みモデルを変えた後などに実行してください。/ Rebuild embeddings.",
      inputSchema: {
        force: z.boolean().optional().describe("true なら全ての記憶を作り直す (既定 false: 未生成・古いものだけ)"),
      },
    },
    async ({ force }) => {
      const res = await reindex(store, settings, { force });
      const lines = res.spaces.map(
        (s) => `  - ${s.id} (${s.model}): ${s.processed} 件成功 / ${s.failed} 件失敗${s.error ? ` — ${s.error}` : ""}`,
      );
      return text(["埋め込みを再生成しました。", ...lines].join("\n"));
    },
  );

  return server;
}
