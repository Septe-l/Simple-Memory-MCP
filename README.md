# Simple-Memory-MCP

## 概要

このMCPツールは、LLMで会話した内容の記憶・呼び出し・WebUIでの作成/編集/削除を可能にした、シンプルな長期記憶MCPサーバーです。

HTTPで動作しDockerコンテナとして扱えるので、LLMを動かすサーバーとは別のマシンで稼働させることが可能になっています。

このMCPツールを使用するには、EmbeddingモデルをLMStudioで動作させておく必要があります。

このREADMEを除くすべてはClaude Codeで書かれています。

## クイックスタート

Dockerを使うのが最も手軽です。

```bash
git clone https://github.com/Septe-l/Simple-Memory-MCP.git
cd Simple-Memory-MCP
docker compose up -d
```

http://マシンのIPアドレス:8080/mcp をmcp.jsonや各ツールに登録してください。
ブラウザから http://マシンのIPアドレス:8080/webui にアクセスすることで、記憶の追加・編集・削除、各種設定が可能なWebUIにアクセス可能です。

## 仕組み

LLMに記憶の読み出し・書き込み・検索などのツールを提供します。

LLMによって各ツールが呼び出されると、LLMの指示に沿って記憶した内容の読み出し・新規の記憶・記憶の検索などを行います。

記憶する度合いの設定も可能です。(提示されるプロンプトが変わるので、提示されたものをLLMに登録してください)

## 補足

小規模なLLMではツールが上手く呼び出されないことがあるので、WebUIで提示されたプロンプトを組み込むことを推奨します。

WebUIとMCPツールは同じポートで動作します。

設定項目・検索の仕組み・REST APIなどの詳細は [doc/README.md](doc/README.md) にまとめてあります。

## ライセンス

このプログラムは [MITライセンス](LICENSE) の下でリリースされています。
