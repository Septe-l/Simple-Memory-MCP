# Simple-Memory-MCP — 詳細ドキュメント

> これは自動生成された詳細ドキュメントです。プロジェクトの入口は [ルートの README](../README.md) です。

LM Studio の LLM に**長期記憶**を与える MCP サーバー。HTTP 接続（Streamable HTTP）で動き、記憶の**追加・検索・編集・削除**ができる WebUI を同じポートで配信します。

- 記憶は SQLite ファイル 1 つに保存
- 検索は **意味検索（ベクトル）+ キーワード検索** のハイブリッド、**日本語・英語の両対応**
- 埋め込みサーバーの **URL とモデルを WebUI から変更可能**（別マシンで動かせる）
- Docker Compose で単一コンテナとして起動可能
- ネイティブビルド不要・ビルドステップ不要（Node が `.ts` を直接実行、SQLite は `node:sqlite`）

| | |
| --- | --- |
| WebUI | `http://<ホスト>:8080/webui` |
| MCP | `http://<ホスト>:8080/mcp` |

---

## 起動

### Docker Compose（推奨）

```bash
docker compose up -d
```

初回のみ、埋め込みサーバーの向き先を指定します（`.env` か `docker-compose.yml`）。コンテナからホストの LM Studio を見る場合は `host.docker.internal` を使います。

```bash
EMBEDDING_BASE_URL=http://host.docker.internal:1234/v1
```

記憶は名前付き volume `memory-data`（コンテナ内 `/data`）に残るので、コンテナを作り直しても消えません。

### 直接起動

```bash
npm install && npm start
```

Node.js 22.6 以上が必要です（`.ts` の直接実行と `node:sqlite` を使用）。

---

## LM Studio から接続する

LM Studio の右サイドバー **Program → Install → Edit `mcp.json`** に追記します。

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

別マシンで動かしている場合は `127.0.0.1` をそのマシンの IP に変えてください。

### モデルに記憶を拾わせる

記憶を「保存する」より「参照する」ほうが難しく、ローカルモデルは指示が弱いと `memory_search` を呼ばずに答えてしまいます。対策を 3 段階で入れてあります。

1. **MCP の `instructions` とツール説明文** — 「回答する前に必ず呼ぶ」「会話の最初の発言では必須」「『覚えてる?』『私の』が出たら必須」「検索せずに『わからない』と答えてはいけない」を明記
2. **`query` を省略可能に** — 引数なしで `memory_search` を呼ぶと重要度順に記憶が返ります。「とりあえず最初に呼ぶ」のコストを下げるためで、何を検索すべきか決められないモデルでも呼べます
3. **空振りしても記憶の存在を返す** — 一致する記憶が無いときも「記憶は全部で N 件あります」と主要なものを添えて返します。空の結果を「記憶が無い」と解釈して以後呼ばなくなるのを防ぐためです

それでも呼んでくれない場合は、**WebUI の ⚙設定 にある「LM Studio の System Prompt（推奨）」を「コピー」して**、LM Studio のチャット設定の System Prompt に貼ってください。記憶レベルの設定を反映した文面が生成されます。これが最も確実です。

---

## 会話内容を記憶する度合い

WebUI の ⚙設定 にあるスライダーで、どこまで細かく覚えるかを 5 段階で変えられます。左に寄せるほど重要な話題だけ、右に寄せるほど細かいことまで記憶します。

| レベル | ラベル | 保存する重要度 | 方針 |
| --- | --- | --- | --- |
| 1 | 核心のみ | 5 以上 | 長期に変わらない核心的な事実だけ（名前・家族構成・恒久的な好み・重大な決定） |
| 2 | 重要なことだけ | 4 以上 | 継続している仕事・趣味・はっきりした選好まで |
| 3 | 標準（既定） | 3 以上 | 好み・決定事項・進行中の作業・環境など |
| 4 | 細かめ | 2 以上 | 一時的な状況や細かい好みも |
| 5 | ほぼ全部 | 1 以上 | 会話に出た事実は幅広く |

何を記憶するかを最終的に決めるのは LLM なので、この設定は 2 段構えで効かせています。

1. **モデルの判断を誘導する** — MCP の `instructions` と `memory_add` のツール説明文が、選んだレベルの方針文に応じて書き換わります
2. **実際に拒否する** — 閾値を下回る重要度で `memory_add` が呼ばれた場合は保存せず、「なぜ保存しなかったか」と現在の方針をモデルに返します

> WebUI から手動で追加する記憶にはこの閾値は適用されません（人が明示的に追加した操作のため）。閾値がかかるのは MCP 経由の保存だけです。

---

## 埋め込みモデルの設定

WebUI 右上の **⚙ 設定** から、サーバー URL・モデル・接頭辞をいつでも変更できます（再起動不要）。**接続テスト**ボタンで疎通とモデルの確認ができ、**一覧**ボタンでそのサーバーが提供しているモデル名を取得できます。

### 空間（space）という考え方

埋め込みは「空間」単位で管理します。1 つの記憶を複数の空間に索引でき、検索時はすべての空間の結果を統合します。

| 空間 | 既定 | 用途 |
| --- | --- | --- |
| **主空間 (primary)** | `text-embedding-multilingual-e5-large-instruct`（多言語）**有効** | 日本語・英語の両方をこれ 1 つでカバーする |
| **副空間 (secondary)** | `text-embedding-nomic-embed-text-v1.5`（英語特化）**無効** | 言語特化モデルを別サーバーで併用したいときだけ有効にする |

各空間には「モデルの対応言語」を設定します。`多言語` なら常に等倍、`日本語特化` / `英語特化` はクエリの言語が違うとき重みが 0.4 倍に下がります。

> **副空間が既定で無効な理由**: 日英が混在した記憶に対して実測したところ、多言語モデル単独で 14/16 だった正解率が、英語特化モデルを併用すると 10/16 に下がりました。言語特化モデルは自分の言語以外の記憶に対してノイズになります。**別マシンに言語特化モデルを立てる構成**（下記）でのみ有効にすることを勧めます。

### 別マシンで埋め込みを動かす

メイン LLM・埋め込み・この MCP サーバーを別々のマシンに分ける構成にも対応しています。設定画面でサーバー URL をそのマシンのアドレスにするだけです。

```
主空間  : http://192.168.1.20:1234/v1   (Mac mini M1 の LM Studio)
副空間  : http://192.168.1.30:8081/v1   (別マシンの llama-server)
```

埋め込み専用機には LM Studio のほか、llama.cpp の `llama-server` も使えます（OpenAI 互換の `/v1/embeddings` を提供します）。

```bash
llama-server -m /path/to/model.gguf --embeddings --host 0.0.0.0 --port 8081
```

### 接頭辞（プレフィックス）

モデルによっては、クエリ側と文書側に決まった接頭辞を付けないと精度が大きく落ちます。モデル名から自動判別しますが、設定画面で上書きできます。

| モデル | クエリ | 文書 |
| --- | --- | --- |
| ruri 系 | `検索クエリ: ` | `検索文書: ` |
| nomic-embed 系 | `search_query: ` | `search_document: ` |
| e5 系 | `query: ` | `passage: ` |
| bge-m3 | （なし） | （なし） |

モデルか文書側の接頭辞を変えると、既存のベクトルは自動的に「未索引」として扱われます。設定画面の **埋め込みを再生成** を押してください。

### ⚠️ ruri-v3-310m について

`Targoyle/ruri-v3-310m-GGUF` は **LM Studio の `/v1/embeddings` からは使えません**。GGUF 自体は `pooling_type=1` / `causal=false` を持つ正常な埋め込みモデルですが、LM Studio が arch `modern-bert` を「LLM」に分類し、埋め込みモデルとして登録しないためです（LM Studio 0.4.20 で確認）。

- `lms ls` で EMBEDDING ではなく LLM のセクションに出る
- ruri だけをロードして `/v1/embeddings` を叩くと `No models loaded` が返る

使いたい場合は、llama.cpp の `llama-server`（上記）で配信し、そのアドレスを空間の URL に設定してください。llama.cpp は modern-bert に対応しています。

> このサーバーは、要求したモデルと実際に応答したモデルが違う場合を検出して警告します。LM Studio は条件によって**エラーを返さずに別のロード済みモデルのベクトルを返す**ことがあり、気付かないまま全く違うモデルで索引を作ってしまうためです。

---

## 検索の仕組み

1. **キーワード検索** — 日本語は形態素解析を使わず**文字 bigram**で照合します（SQLite FTS5 の既定トークナイザは日本語を 1 トークンに潰してしまうため）。各トークンの重みは次で決まります。
   - **IDF** — 多くの記憶に出てくるトークンほど軽くする（BM25 と同じ式）
   - **内容語らしさ** — ひらがなだけの bigram（「てい」「いる」）は 0.25 倍、英語の機能語（the / their / about）は 0.15 倍
   - **単語境界** — ラテン文字は部分一致させない（`me` が `memory` にヒットするのを防ぐ）
   - **下限** — 一致度 0.25 未満は候補にしない
2. **意味検索** — 有効な各空間でコサイン類似度を計算。ベクトルは起動時にメモリへ載せます。
3. **統合** — キーワードと各空間の順位を **RRF（Reciprocal Rank Fusion, k=10）** で融合し、重要度で ±4% 微調整します。

> **調整の根拠（実測）**: RRF の定数は一般に 60 ですが、それだと順位差が 1% 程度しか付かず重要度ブーストが順位を支配したため 10 にしました。またキーワードの下限が無いと、助詞由来の bigram が 1 つ引っかかっただけの記憶が RRF でキーワード側 1 位となって上位に飛び出し、日英混在コーパスで 14/16 → 12/16 に落ちました。

### 精度の実測値

日英が混在した 8 件の記憶に対し、21 種類のクエリ（日本語・英語・クロスリンガル・固有名詞の完全一致）で 1 位が正解かを測定：**19/21**。

外したのは「楽器は何か弾ける？」「どこにデプロイしてる？」の 2 件で、いずれも**日本語のクエリで英語の記憶を引く**ケースです。多言語埋め込みはクエリと同じ言語の文書を優先しやすく、混在コーパスでは同言語の記憶に負けることがあります。記憶を書く言語を揃えると、この問題は起きません。

### 重複の自動検知

`memory_add` のとき、既存の記憶とのコサイン類似度が **0.95 以上**なら新規作成せず、タグだけをマージして既存の記憶を返します。同じことを何度も覚えて記憶が汚れるのを防ぎます。

---

## MCP ツール

| ツール | 用途 |
| --- | --- |
| `memory_search` | 記憶を検索（意味＋キーワード）。`query` / `limit` / `tag` |
| `memory_add` | 記憶を追加。`content` / `tags` / `importance` |
| `memory_update` | 既存の記憶を更新。`id` / `content` / `tags` / `importance` |
| `memory_delete` | 記憶を削除。`ids`（配列） |
| `memory_list` | 新しい順に一覧。`limit` / `offset` / `tag` |
| `memory_stats` | 件数・タグ内訳・索引の状態 |
| `memory_reindex` | 埋め込みの再生成。`force` |

---

## 環境変数

`.env.example` を参照。**すべて任意**で、値が使われるのは「設定がまだ DB に保存されていないとき」だけです。

> ⚠️ 一度 WebUI で設定を保存すると、以後は DB の値が優先されます。`docker-compose.yml` を書き換えて反映させたいときは、設定画面の **既定値に戻す** を押してください。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `MEMORY_MCP_HOST` | `0.0.0.0` | 待ち受けホスト |
| `MEMORY_MCP_PORT` | `8080` | 待ち受けポート |
| `MEMORY_DB_PATH` | `data/memory.db` | SQLite ファイルの場所（Docker では `/data/memory.db`） |
| `EMBEDDING_BASE_URL` | `http://localhost:1234/v1` | 埋め込みサーバーの既定 URL |
| `EMBEDDING_API_KEY` | `lm-studio` | 認証が必要な場合のみ |
| `EMBEDDING_PRIMARY_MODEL` | `text-embedding-multilingual-e5-large-instruct` | 主空間のモデル |
| `EMBEDDING_PRIMARY_LANGUAGE` | `multilingual` | `multilingual` / `ja` / `en` |
| `EMBEDDING_SECONDARY_ENABLED` | `false` | 副空間を使うか |
| `EMBEDDING_SECONDARY_MODEL` | `text-embedding-nomic-embed-text-v1.5` | 副空間のモデル |
| `EMBEDDING_SECONDARY_LANGUAGE` | `en` | 同上 |
| `EMBEDDING_{PRIMARY,SECONDARY}_BASE_URL` | `EMBEDDING_BASE_URL` | 空間ごとに別サーバーを使う場合 |
| `EMBEDDING_{PRIMARY,SECONDARY}_{QUERY,DOCUMENT}_PREFIX` | モデルから自動判別 | 接頭辞の上書き |
| `SEMANTIC_WEIGHT` / `KEYWORD_WEIGHT` | `1.0` / `1.0` | 検索スコアの重み |
| `MEMORY_LEVEL` | `3` | 会話内容を記憶する度合い（1〜5） |

---

## REST API（WebUI が使用）

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/health` | 各空間の疎通確認 |
| `GET` | `/api/stats` | 件数・タグ内訳・索引状況 |
| `GET` | `/api/settings` | 現在の設定 |
| `PUT` | `/api/settings` | 設定を更新 |
| `POST` | `/api/settings/reset` | 環境変数の既定値に戻す |
| `POST` | `/api/settings/test` | 保存せずに疎通確認 |
| `GET` | `/api/settings/models?baseUrl=` | サーバーのモデル一覧 |
| `GET` | `/api/settings/prefixes?model=` | モデル名から推奨接頭辞 |
| `GET` | `/api/memories?q=&tag=&limit=&offset=&sort=` | `q` があれば検索、無ければ一覧 |
| `GET` | `/api/memories/:id` | 1 件取得 |
| `POST` | `/api/memories` | 追加 |
| `PATCH` | `/api/memories/:id` | 更新 |
| `DELETE` | `/api/memories/:id` | 削除 |
| `POST` | `/api/memories/bulk-delete` | 一括削除（`{"ids":[...]}`） |
| `POST` | `/api/reindex` | 埋め込み再生成（`{"force":true}` で全件） |
| `GET` | `/healthz` | コンテナのヘルスチェック用 |

---

## 構成

```
src/
  index.ts       HTTP サーバー（MCP / REST / 静的配信）
  mcp.ts         MCP ツール定義
  api.ts         REST ルーティング
  settings.ts    実行時に変更できる設定（SQLite 永続化）
  service.ts     追加・更新・再生成（重複検知を含む）
  search.ts      ハイブリッド検索（bigram + 複数ベクトル空間 + RRF）
  db.ts          SQLite 永続化とベクトルキャッシュ
  embeddings.ts  OpenAI 互換の埋め込みクライアント（モデル不一致の検出付き）
  config.ts      起動時設定と接頭辞の自動判別
public/          WebUI（依存なしのバニラ JS）
Dockerfile / docker-compose.yml
```

MCP は**ステートレス**で動きます（リクエストごとに server / transport を使い捨て）。セッション管理が要らないぶん、クライアント側の実装差で詰まりにくくなっています。

## 注意

- 認証はありません。LAN に公開する場合は前段にリバースプロキシと認証を置いてください。
- 記憶の削除は取り消せません。volume（または `data/memory.db`）を定期的にコピーしておくとバックアップになります。
- Docker Desktop は macOS 12 以降が必要です。古い Mac で動かす場合は Linux を入れるか、`npm start` で直接起動してください。
