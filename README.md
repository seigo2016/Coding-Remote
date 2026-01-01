# Claude Code Approval Bot

Claude CodeのHooksと連携し、ツール実行の承認をDiscord経由で行うBot。
離席時もDiscordからCLIセッションの操作が可能。

## 動作環境

- **Bot実行場所**: WSL2（Claude Code VSCodeと同じ環境）
- **対象環境**: Windows + WSL2 + VSCode Remote WSL
- **Node.js**: 22 LTS

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
│         Approval Bot（WSL2でバックグラウンド常駐）            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  HTTP API Server ←→ Discord Bot ←→ PTY Manager    │    │
│  │  (localhost:3456)     (discord.js)   (node-pty)   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           ↓
                    ┌──────────────┐
                    │   Discord    │
                    │  承認ボタン   │
                    │  /コマンド    │
                    └──────────────┘
```

## 機能

### 承認ワークフロー
- VSCode Claude Code拡張のツール実行前にHookが発火
- Discordにボタン付き承認リクエストを送信
- ✅許可 / ❌拒否 / 📋全て許可 / 🛑中断 から選択

### Discordコマンド
| コマンド | 説明 |
|---------|------|
| `/continue` | CLIセッションを開始（`claude --continue`） |
| `/ask <prompt>` | プロンプトをCLIに送信 |
| `/output [lines]` | 最新の出力を表示（デフォルト50行） |
| `/stop` | CLIセッションを停止 |
| `/status` | セッション状態を表示 |

## WSL2 セットアップ手順

### 1. 前提条件

```bash
# Node.js 22 LTSがインストールされていること
node -v  # v22.x.x

# pnpmがインストールされていること
pnpm -v

# Claude Code CLIがインストールされていること
claude --version
```

### 2. Discord Bot作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. "New Application" をクリック
3. Bot設定:
   - Bot → "Add Bot"
   - "MESSAGE CONTENT INTENT" を有効化
   - "Reset Token" でトークンを取得
4. OAuth2設定:
   - OAuth2 → URL Generator
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`
5. 生成されたURLでBotをサーバーに招待

### 3. プロジェクトセットアップ

```bash
# リポジトリクローン
git clone https://github.com/seigo2016/Coding-Remote.git
cd Coding-Remote

# 依存関係インストール
pnpm install

# 環境変数設定
cp .env.example .env
```

`.env` を編集:
```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_OWNER_ID=your_discord_user_id
DISCORD_CHANNEL_ID=your_channel_id
API_PORT=3456
API_HOST=127.0.0.1
CLAUDE_WORKING_DIR=/path/to/your/project
LOG_LEVEL=info
```

### 4. Claude Code Hooks設定

`~/.claude/settings.json` を編集（なければ作成）:

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

### 5. Bot起動

```bash
# 開発モード
pnpm dev

# または本番モード
pnpm build
pnpm start
```

### 6. 常駐化（systemd）

`~/.config/systemd/user/claude-approval-bot.service` を作成:

```ini
[Unit]
Description=Claude Code Approval Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/Coding-Remote
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

有効化:
```bash
systemctl --user daemon-reload
systemctl --user enable claude-approval-bot
systemctl --user start claude-approval-bot

# ログ確認
journalctl --user -u claude-approval-bot -f

# WSL2起動時に自動起動させる場合
sudo loginctl enable-linger $USER
```

### 7. 常駐化（PM2を使う場合）

```bash
# PM2インストール
npm install -g pm2

# 起動
pm2 start pnpm --name "claude-approval-bot" -- start

# 自動起動設定
pm2 startup
pm2 save
```

## 使い方

### デスクトップ作業時
1. VSCode + Claude Code拡張を普段通り使用
2. ツール実行時にDiscordに承認リクエストが届く
3. デスクトップでもDiscordでも承認可能

### 離席時
1. Discordで `/continue` → CLIセッション開始
2. `/ask 質問やプロンプト` → 指示を送信
3. `/output` → 結果確認
4. `/stop` → セッション終了

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
| `CLAUDE_WORKING_DIR` | CLIセッションの作業ディレクトリ | (カレント) |
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
│   ├── client.ts         # Discord Bot（承認UI + コマンド）
│   └── types.ts
├── pty/
│   ├── manager.ts        # PTYセッション管理 (node-pty)
│   └── types.ts
└── utils/
    ├── logger.ts         # pino logger
    └── error.ts          # カスタムエラー

hooks/
└── pre-tool-use.js       # Claude Code Hook スクリプト
```

## 技術スタック

- TypeScript 5.x
- Node.js 22 LTS
- discord.js v14
- node-pty (pseudo-terminal)
- pino (logging)
- zod (validation)
- vitest (testing)
- tsup (build)

## ライセンス

MIT
