# Claude Code Approval Bot

Claude CodeのHooksと連携し、ツール実行の承認をDiscord経由で行うBot。
離席時もDiscordからCLIセッションの操作が可能。

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

### プロジェクト別スレッド管理
- 作業ディレクトリ（cwd）ごとにDiscordスレッドを自動作成
- プロジェクトごとに会話が分離され、通知が整理される
- スレッド名は `📁 プロジェクト名` 形式
- 既存スレッドがあれば再利用、アーカイブ済みでも自動復元

### 承認ワークフロー
- VSCode Claude Code拡張のツール実行前にHookが発火
- Discordの対応プロジェクトスレッドにボタン付き承認リクエストを送信
- ✅許可 / ❌拒否 / 📋全て許可 / 🛑中断 から選択

### 承認モード設定
プロジェクトごとに異なる承認モードを設定可能。

| モード | 説明 |
|--------|------|
| `discord` | Discord経由で承認（デフォルト） |
| `vscode` | VSCodeのネイティブダイアログで承認 |
| `auto` | 全ツールを自動承認（注意） |

**優先順位**: プロジェクト別設定 > グローバル設定 > デフォルト(discord)

設定ファイル:
- グローバル: `~/.claude-approval-mode`
- プロジェクト別: `~/.claude-approval-modes.json`

### Discordコマンド
| コマンド | 説明 |
|---------|------|
| `/sessions` | 利用可能なセッション一覧を表示 |
| `/continue [session_id]` | CLIセッションを開始（省略時は最新） |
| `/takeover <session_id>` | VSCode等からセッションを引き継ぐ（既存プロセスを終了） |
| `/ask <prompt>` | プロンプトをCLIに送信 |
| `/output [lines]` | 最新の出力を表示（デフォルト50行） |
| `/stop` | CLIセッションを停止 |
| `/status` | セッション状態を表示 |
| `/mode [mode]` | 承認モードを変更/確認（スレッド内ではプロジェクト別） |
| `/mode clear` | プロジェクト別設定を削除（スレッド内のみ） |

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
│   ├── thread-manager.ts # プロジェクト別スレッド管理
│   └── types.ts
├── pty/
│   ├── manager.ts        # PTYセッション管理 (node-pty)
│   └── types.ts
└── utils/
    ├── logger.ts         # pino logger
    ├── mode.ts           # グローバル承認モード管理
    ├── project-mode.ts   # プロジェクト別承認モード管理
    └── error.ts          # カスタムエラー

hooks/
└── pre-tool-use.cjs      # Claude Code Hook スクリプト
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
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Coding-Remote/hooks/pre-tool-use.cjs",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

**重要**: `timeout: 300` (5分) を設定することで、Discord承認を待つ時間を確保できます。

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
| `CLAUDE_WORKING_DIR` | CLIセッションの作業ディレクトリ | (カレントディレクトリ) |
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
- Node.js 24 LTS
- discord.js v14
- node-pty (pseudo-terminal)
- pino (logging)
- zod (validation)
- vitest (testing)
- tsup (build)
