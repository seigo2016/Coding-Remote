# Claude Discord Bot

Discord経由でClaude Codeセッションをリモート操作するためのBot。

## プロジェクト構造

```
src/
├── index.ts                 # エントリーポイント
├── config/                  # 設定管理 (zod validation)
├── tmux/                    # tmuxセッション操作
│   ├── manager.ts           # セッション作成・監視・入力
│   └── types.ts
├── parser/                  # Claude Code出力解析
│   ├── claude-output.ts     # 状態検出パーサー
│   ├── diff-formatter.ts    # diff整形
│   └── types.ts
├── discord/                 # Discord.js連携
│   ├── client.ts            # Botクライアント
│   └── types.ts
├── session/                 # セッション管理
│   ├── orchestrator.ts      # 全体統合
│   └── types.ts
└── utils/
    ├── logger.ts            # pino logger
    └── error.ts             # カスタムエラー
```

## 開発コマンド

```bash
pnpm install        # 依存関係インストール
pnpm dev            # 開発モード (tsx watch)
pnpm build          # ビルド
pnpm start          # 本番起動
pnpm typecheck      # 型チェック
pnpm lint           # Lint
pnpm test           # テスト
```

## 環境変数

`.env.example` を `.env` にコピーして設定:

- `DISCORD_BOT_TOKEN`: Discord Bot トークン
- `DISCORD_OWNER_ID`: 操作を許可するユーザーID
- `DISCORD_CHANNEL_ID`: 通知先チャンネルID
- `CLAUDE_WORKING_DIR`: 作業ディレクトリ
- `TMUX_SESSION_NAME`: tmuxセッション名

## アーキテクチャ

1. **TmuxManager**: tmuxセッションを作成・監視、2秒ごとにポーリング
2. **ClaudeOutputParser**: ターミナル出力を解析して状態検出
3. **DiscordBot**: discord.js v14、スラッシュコマンド + ボタンUI
4. **SessionOrchestrator**: 全体を統合、状態遷移管理

## 技術スタック

- TypeScript 5.x
- Node.js 20 LTS
- discord.js v14
- pino (logging)
- zod (validation)
- vitest (testing)
- tsup (build)
