import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";
import { DiscordBot } from "./discord/client.js";
import { ApprovalServer } from "./api/server.js";
import { PtyManager } from "./pty/manager.js";
import { ApprovalAction } from "./discord/types.js";
import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from "discord.js";

async function main() {
  logger.info("Starting Claude Code Approval Bot...");

  const discord = new DiscordBot();
  const api = new ApprovalServer();
  const pty = new PtyManager(config.pty.workingDir);

  // Helper to refresh session cache for autocomplete
  const refreshSessionCache = async () => {
    const sessions = await pty.listSessions();
    discord.updateSessionCache(sessions);
    return sessions;
  };

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

  // ============================================
  // Discord Command Handlers
  // ============================================

  // /sessions - Show session list with Select Menu
  discord.on("command:sessions", async (interaction: ChatInputCommandInteraction) => {
    try {
      const sessions = await refreshSessionCache();
      const { embeds, components } = discord.buildSessionListComponents(sessions);
      await interaction.editReply({ embeds, components });
    } catch (error) {
      logger.error({ error }, "Failed to list sessions");
      await interaction.editReply("❌ セッション一覧の取得に失敗しました");
    }
  });

  // Refresh button on session list
  discord.on("command:sessions:refresh", async (interaction: ButtonInteraction) => {
    try {
      const sessions = await refreshSessionCache();
      const { embeds, components } = discord.buildSessionListComponents(sessions);
      await interaction.editReply({ embeds, components });
    } catch (error) {
      logger.error({ error }, "Failed to refresh sessions");
    }
  });

  // /continue - Start session (with autocomplete support)
  discord.on(
    "command:continue",
    async (sessionId: string | null, interaction: ChatInputCommandInteraction) => {
      try {
        if (pty.isRunning) {
          await interaction.editReply("⚠️ セッションは既に実行中です");
          return;
        }

        await pty.startSession(sessionId ?? undefined);
        const msg = sessionId
          ? `✅ セッション \`${sessionId.slice(0, 8)}...\` を再開しました`
          : "✅ 最新のセッションを開始しました";
        await interaction.editReply(msg);
      } catch (error) {
        logger.error({ error }, "Failed to start session");
        await interaction.editReply("❌ セッション開始に失敗しました");
      }
    }
  );

  // Start session from Select Menu or Button
  discord.on(
    "command:continue:select",
    async (sessionId: string | null, interaction: ButtonInteraction | StringSelectMenuInteraction) => {
      try {
        if (pty.isRunning) {
          await interaction.editReply({
            embeds: [],
            components: [],
            content: "⚠️ セッションは既に実行中です",
          });
          return;
        }

        await pty.startSession(sessionId ?? undefined);
        const msg = sessionId
          ? `✅ セッション \`${sessionId.slice(0, 8)}...\` を再開しました`
          : "✅ 最新のセッションを開始しました";
        await interaction.editReply({ embeds: [], components: [], content: msg });
      } catch (error) {
        logger.error({ error }, "Failed to start session");
        await interaction.editReply({
          embeds: [],
          components: [],
          content: "❌ セッション開始に失敗しました",
        });
      }
    }
  );

  // /ask - Modal input for prompt
  discord.on(
    "command:ask",
    async (prompt: string, interaction: ChatInputCommandInteraction | ModalSubmitInteraction) => {
      try {
        if (!pty.isRunning) {
          await interaction.editReply(
            "⚠️ セッションが実行されていません。`/continue` で開始してください"
          );
          return;
        }

        pty.writeLine(prompt);

        const truncatedPrompt = prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt;
        await interaction.editReply({
          content: `📝 プロンプトを送信しました`,
          embeds: [
            {
              description: `\`\`\`\n${truncatedPrompt}\n\`\`\``,
              color: 0x22c55e,
            },
          ],
        });
      } catch (error) {
        logger.error({ error }, "Failed to send prompt");
        await interaction.editReply("❌ プロンプト送信に失敗しました");
      }
    }
  );

  // /output - Paginated output display
  discord.on(
    "command:output",
    async (lines: number, interaction: ChatInputCommandInteraction) => {
      try {
        const output = pty.getOutput(lines);
        if (!output || output.trim() === "") {
          await interaction.editReply("📭 出力がありません");
          return;
        }

        await discord.sendPaginatedOutput(output, interaction);
      } catch (error) {
        logger.error({ error }, "Failed to get output");
        await interaction.editReply("❌ 出力取得に失敗しました");
      }
    }
  );

  // Quick output button
  discord.on(
    "command:output:quick",
    async (lines: number, interaction: ButtonInteraction) => {
      try {
        const output = pty.getOutput(lines);
        if (!output || output.trim() === "") {
          await interaction.followUp({ content: "📭 出力がありません", ephemeral: true });
          return;
        }

        await discord.sendPaginatedOutput(output, interaction);
      } catch (error) {
        logger.error({ error }, "Failed to get output");
      }
    }
  );

  // /stop - Stop session
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

  // Quick stop button
  discord.on("command:stop:quick", async (interaction: ButtonInteraction) => {
    try {
      if (!pty.isRunning) {
        await interaction.followUp({ content: "⚠️ 実行中のセッションがありません", ephemeral: true });
        return;
      }

      await pty.stopSession();
      await interaction.followUp({ content: "🛑 セッションを停止しました", ephemeral: true });
    } catch (error) {
      logger.error({ error }, "Failed to stop session");
    }
  });

  // /status - Session status with action buttons
  discord.on("command:status", async (interaction: ChatInputCommandInteraction) => {
    const session = pty.getSessionInfo();
    const { embeds, components } = discord.buildStatusEmbed({
      isRunning: pty.isRunning,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      workingDir: session.workingDir,
      bufferSize: session.outputBuffer.length,
    });

    await interaction.editReply({ embeds, components });
  });

  // ============================================
  // Startup
  // ============================================

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

    // Initial session cache load
    await refreshSessionCache();

    await discord.sendNotification("🤖 Approval Bot is online", "success");
    logger.info("Claude Code Approval Bot is running");
  } catch (error) {
    logger.error({ error }, "Failed to start bot");
    process.exit(1);
  }
}

main();
