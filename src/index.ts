import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bootConfig, WEBUI_PATH } from "./config.ts";
import { MemoryStore } from "./db.ts";
import { SettingsStore } from "./settings.ts";
import { createMcpServer } from "./mcp.ts";
import { createApiRouter } from "./api.ts";
import { checkSpace } from "./embeddings.ts";

const store = new MemoryStore();
const settings = new SettingsStore(store.db);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

// ローカル利用が前提だが、ブラウザ経由の MCP クライアントも想定して CORS を許可する
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// --- MCP エンドポイント (Streamable HTTP / ステートレス) ---
// セッションを持たないので、リクエストごとに server と transport を使い捨てる。
app.post("/mcp", async (req, res) => {
  const server = createMcpServer(store, settings);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] リクエスト処理に失敗:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// ステートレス構成では SSE ストリームとセッション削除は使わない
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. このサーバーはステートレスな POST のみ対応しています。" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// --- WebUI 用 REST API ---
app.use("/api", createApiRouter(store, settings));

// --- WebUI (/webui で配信) ---
app.use(WEBUI_PATH, express.static(bootConfig.publicDir));
app.get("/", (_req, res) => res.redirect(WEBUI_PATH));
// コンテナのヘルスチェック用 (埋め込みバックエンドの状態には依存しない)
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[error]", err);
  if (res.headersSent) return;
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

const httpServer = app.listen(bootConfig.port, bootConfig.host, () => {
  const shown = bootConfig.host === "0.0.0.0" ? "localhost" : bootConfig.host;
  const base = `http://${shown}:${bootConfig.port}`;
  console.log("─".repeat(64));
  console.log("  Simple-Memory-MCP が起動しました");
  console.log(`  WebUI      : ${base}${WEBUI_PATH}`);
  console.log(`  MCP (HTTP) : ${base}/mcp`);
  console.log(`  DB         : ${bootConfig.dbPath}`);
  console.log("─".repeat(64));

  void Promise.all(settings.get().spaces.map((space) => checkSpace(space))).then((results) => {
    for (const r of results) {
      if (!r.enabled) {
        console.log(`  · [${r.id}] 無効`);
      } else if (r.modelMismatch) {
        console.log(`  ✗ [${r.id}] ${r.model} @ ${r.baseUrl}`);
        console.log(`      ${r.detail}`);
        console.log("      → このままだと意図と違うモデルで索引が作られます。設定画面で確認してください。");
      } else if (r.ok) {
        console.log(`  ✓ [${r.id}] ${r.model} @ ${r.baseUrl} (${r.dimensions} 次元)`);
      } else {
        console.log(`  ✗ [${r.id}] ${r.model} @ ${r.baseUrl}`);
        console.log(`      ${r.detail}`);
      }
    }
    if (results.some((r) => r.enabled && !r.ok)) {
      console.log(`  設定は WebUI (${base}${WEBUI_PATH}) から変更できます。`);
    }
  });
});

function shutdown(signal: string) {
  console.log(`\n${signal} を受信しました。終了します...`);
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
