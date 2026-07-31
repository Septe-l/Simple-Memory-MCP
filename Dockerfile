# Node 22.6 以降は .ts をそのまま実行でき、SQLite も node:sqlite で内蔵されている。
# そのためビルドステップもネイティブモジュールのコンパイルも不要。
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依存だけ先に入れて、ソース変更時のレイヤーキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# コンテナ内では全インターフェースで待ち受け、DB は volume に置く
ENV MEMORY_MCP_HOST=0.0.0.0 \
    MEMORY_MCP_PORT=8080 \
    MEMORY_DB_PATH=/data/memory.db

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]

# 埋め込みバックエンドの状態には依存しない、プロセスの生存確認だけ
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
