# Claude Code Approval Bot

Claude CodeのHooksと連携し、ツール実行の承認をDiscord経由で行うBot。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│           VSCode + Claude Code拡張（普段通り使用）           │
│                          │                                  │
│                          ↓ PreToolUse Hook                  │
│              ┌───────────────────────────┐                  │
│              │  hooks/pre-tool-use.js    │                  │
│              │  → HTTP API に承認要求     │                  │
│              └───────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│         Approval Bot（バックグラウンド常駐）                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  HTTP API Server ←→ Discord Bot                    │    │
│  │  (localhost:3456)     (discord.js)                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           ↓
                    ┌──────────────┐
                    │   Discord    │
                    │  承認ボタン   │
                    └──────────────┘
```

## プロジェクト構造

```
src/
├── index.ts              # エントリーポイント
├── config/
│   └── index.ts          # 設定管理 (zod)
├── api/
│   ├── server.ts         # HTTP APIサーバー
│   └── types.ts
├── discord/
│   ├── client.ts         # Discord Bot（承認UI）
│   └── types.ts
└── utils/
    ├── logger.ts         # pino logger
    └── error.ts          # カスタムエラー

hooks/
└── pre-tool-use.js       # Claude Code Hook スクリプト
```

## セットアップ

### 1. Bot起動

```bash
pnpm install
cp .env.example .env
# .env を編集してDiscordトークン等を設定
pnpm dev  # または pnpm build && pnpm start
```

### 2. Claude Code Hooks設定

`~/.claude/settings.json` に追加:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "command": "node /path/to/Coding-Remote/hooks/pre-tool-use.js"
      }
    ]
  }
}
```

### 3. 常駐化（オプション）

```bash
# PM2で常駐
pm2 start pnpm --name "claude-approval-bot" -- start
pm2 startup
pm2 save
```

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン | (必須) |
| `DISCORD_OWNER_ID` | 操作を許可するユーザーID | (必須) |
| `DISCORD_CHANNEL_ID` | 通知先チャンネルID | (必須) |
| `API_PORT` | APIサーバーポート | 3456 |
| `API_HOST` | APIサーバーホスト | 127.0.0.1 |
| `APPROVAL_TIMEOUT_MS` | 承認タイムアウト (ms) | 300000 |
| `APPROVAL_DEFAULT_ACTION` | タイムアウト時の動作 | approve |
| `LOG_LEVEL` | ログレベル | info |

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

## 技術スタック

- TypeScript 5.x
- Node.js 22 LTS
- discord.js v14
- pino (logging)
- zod (validation)
- vitest (testing)
- tsup (build)
