import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";
import { DiscordBot } from "./discord/client.js";
import { ApprovalServer } from "./api/server.js";
import { PtyManager } from "./pty/manager.js";
import { ApprovalAction } from "./discord/types.js";
import type { ChatInputCommandInteraction } from "discord.js";

async function main() {
  logger.info("Starting Claude Code Approval Bot...");

  const discord = new DiscordBot();
  const api = new ApprovalServer();
  const pty = new PtyManager(config.pty.workingDir);

  // Wire up API to Discord
  api.setApprovalHandler(async (request) => {
    const action = await discord.requestApproval({
      id: request.id,
      tool: request.tool,
      input: request.input,
      timestamp: request.timestamp,
    });

    return {
      approved: action === ApprovalAction.Approve || action === ApprovalAction.ApproveAll,
      action,
    };
  });

  // PTY event handlers
  pty.on("output", (data: string) => {
    logger.debug({ length: data.length }, "PTY output received");
  });

  pty.on("exit", (exitCode: number, signal: number) => {
    logger.info({ exitCode, signal }, "PTY session exited");
    discord.sendNotification(
      `Claude Code セッションが終了しました (code: ${exitCode})`,
      exitCode === 0 ? "info" : "warning"
    );
  });

  // Discord command handlers
  discord.on("command:continue", async (interaction: ChatInputCommandInteraction) => {
    try {
      if (pty.isRunning) {
        await interaction.editReply("⚠️ セッションは既に実行中です");
        return;
      }

      await pty.startSession();
      await interaction.editReply("✅ Claude Code セッションを開始しました");
    } catch (error) {
      logger.error({ error }, "Failed to start session");
      await interaction.editReply("❌ セッション開始に失敗しました");
    }
  });

  discord.on("command:ask", async (prompt: string, interaction: ChatInputCommandInteraction) => {
    try {
      if (!pty.isRunning) {
        await interaction.editReply("⚠️ セッションが実行されていません。`/continue` で開始してください");
        return;
      }

      pty.writeLine(prompt);
      await interaction.editReply(`📝 プロンプトを送信しました:\n\`\`\`\n${prompt}\n\`\`\``);
    } catch (error) {
      logger.error({ error }, "Failed to send prompt");
      await interaction.editReply("❌ プロンプト送信に失敗しました");
    }
  });

  discord.on("command:output", async (lines: number, interaction: ChatInputCommandInteraction) => {
    try {
      const output = pty.getOutput(lines);
      if (!output || output.trim() === "") {
        await interaction.editReply("📭 出力がありません");
        return;
      }

      await discord.sendOutput(output, `最新 ${lines} 行の出力`);
      await interaction.editReply("✅ 出力を送信しました");
    } catch (error) {
      logger.error({ error }, "Failed to get output");
      await interaction.editReply("❌ 出力取得に失敗しました");
    }
  });

  discord.on("command:stop", async (interaction: ChatInputCommandInteraction) => {
    try {
      if (!pty.isRunning) {
        await interaction.editReply("⚠️ 実行中のセッションがありません");
        return;
      }

      await pty.stopSession();
      await interaction.editReply("🛑 セッションを停止しました");
    } catch (error) {
      logger.error({ error }, "Failed to stop session");
      await interaction.editReply("❌ セッション停止に失敗しました");
    }
  });

  discord.on("command:status", async (interaction: ChatInputCommandInteraction) => {
    const session = pty.getSessionInfo();
    const status = session.status === "running" ? "🟢 実行中" : "⚪ 停止中";
    const startedAt = session.startedAt
      ? `開始: ${session.startedAt.toLocaleString("ja-JP")}`
      : "";
    const bufferSize = session.outputBuffer.length;

    await interaction.editReply(
      `**セッション状態**\n` +
        `ステータス: ${status}\n` +
        `作業ディレクトリ: \`${session.workingDir}\`\n` +
        (startedAt ? `${startedAt}\n` : "") +
        `出力バッファ: ${bufferSize} 文字`
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await pty.stopSession();
    await api.stop();
    await discord.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await discord.connect();
    await discord.registerCommands();
    await api.start();
    await discord.sendNotification("🤖 Approval Bot is online", "success");
    logger.info("Claude Code Approval Bot is running");
  } catch (error) {
    logger.error({ error }, "Failed to start bot");
    process.exit(1);
  }
}

main();
