/*
 * Simple-Memory-MCP のサービスワーカー。
 *
 * 記憶そのものはサーバー上の SQLite にあるので、ここでキャッシュするのは
 * 画面を構成する静的ファイル (アプリシェル) だけ。
 * API のレスポンスはキャッシュしない — 古い記憶を表示すると混乱を招くため。
 */

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;

// スコープ基準の相対パス。/webui/ 配下でも別の場所に置いても動くようにする。
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 1 つでも失敗すると install ごと失敗するので、個別に入れて欠けを許容する
      await Promise.all(
        SHELL_ASSETS.map(async (asset) => {
          try {
            await cache.add(new Request(asset, { cache: "reload" }));
          } catch {
            /* 取得できなかったものは諦めてネットワークに任せる */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** API と MCP は常にネットワーク。キャッシュすると古い記憶を見せてしまう。 */
function isDataRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname === "/mcp" || url.pathname === "/healthz";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDataRequest(url)) return; // 既定の挙動 (ネットワーク) に任せる

  // ページ遷移: ネットワーク優先。オフラインならキャッシュした画面を返す。
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match("./index.html")) ?? (await cache.match("./")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // 静的ファイル: キャッシュ優先 + 背後で更新 (stale-while-revalidate)
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) void cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        void network; // 更新はバックグラウンドで
        return cached;
      }
      const res = await network;
      return res ?? Response.error();
    })(),
  );
});

/** 新しい版へ即座に切り替えるためのメッセージ (画面側の「更新」ボタンから) */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});
