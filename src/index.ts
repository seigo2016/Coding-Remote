import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";
import { DiscordBot } from "./discord/client.js";
import { ApprovalServer } from "./api/server.js";
import { PtyManager } from "./pty/manager.js";
import { ApprovalAction } from "./discord/types.js";
import { getApprovalMode, setApprovalMode, getModeDescription, type ApprovalMode } from "./utils/mode.js";
import { setProjectMode, getProjectMode, clearProjectMode } from "./utils/project-mode.js";
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
      cwd: request.cwd,
      sessionId: request.sessionId,
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

  // Send result to Discord when Claude completes a response
  pty.on("result", async (result: string) => {
    logger.info({ resultLength: result.length }, "Claude response completed");

    // Truncate if too long for Discord embed
    const maxLength = 4000;
    const displayResult = result.length > maxLength
      ? result.slice(0, maxLength - 100) + "\n\n... (truncated, use /output for full response)"
      : result;

    try {
      // Get the thread for current working directory
      const threadManager = discord.getThreadManager();
      const cwd = pty.currentWorkingDir;
      const thread = await threadManager.getOrCreateThread(cwd);

      await thread.send({
        embeds: [{
          title: "✅ Claude Response",
          description: `\`\`\`\n${displayResult}\n\`\`\``,
          color: 0x22c55e,
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (error) {
      logger.error({ error }, "Failed to send result to Discord");
    }
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

  // /sessions - Show session list with Select Menu (thread-aware)
  discord.on("command:sessions", async (interaction: ChatInputCommandInteraction) => {
    try {
      // Get project path from thread if in a thread
      const threadManager = discord.getThreadManager();
      const channel = interaction.channel;
      let projectPath: string | undefined;

      if (channel?.isThread()) {
        const path = await threadManager.getProjectPathFromThreadAsync(channel);
        if (path) {
          projectPath = path;
        }
      }

      const sessions = projectPath
        ? await pty.listSessions(projectPath)
        : await refreshSessionCache();
      const { embeds, components } = discord.buildSessionListComponents(sessions, projectPath);
      await interaction.editReply({ embeds, components });
    } catch (error) {
      logger.error({ error }, "Failed to list sessions");
      await interaction.editReply("❌ セッション一覧の取得に失敗しました");
    }
  });

  // Refresh button on session list (thread-aware)
  discord.on("command:sessions:refresh", async (interaction: ButtonInteraction) => {
    try {
      // Get project path from thread if in a thread
      const threadManager = discord.getThreadManager();
      const channel = interaction.channel;
      let projectPath: string | undefined;

      if (channel?.isThread()) {
        const path = await threadManager.getProjectPathFromThreadAsync(channel);
        if (path) {
          projectPath = path;
        }
      }

      const sessions = projectPath
        ? await pty.listSessions(projectPath)
        : await refreshSessionCache();
      const { embeds, components } = discord.buildSessionListComponents(sessions, projectPath);
      await interaction.editReply({ embeds, components });
    } catch (error) {
      logger.error({ error }, "Failed to refresh sessions");
    }
  });

  // /continue - Start session (with autocomplete support, thread-aware)
  discord.on(
    "command:continue",
    async (sessionId: string | null, interaction: ChatInputCommandInteraction) => {
      try {
        if (pty.isRunning) {
          await interaction.editReply("⚠️ セッションは既に実行中です");
          return;
        }

        // Get project path from thread if in a thread
        const threadManager = discord.getThreadManager();
        const channel = interaction.channel;
        let workingDir: string | undefined;

        if (channel?.isThread()) {
          const projectPath = await threadManager.getProjectPathFromThreadAsync(channel);
          if (projectPath) {
            workingDir = projectPath;
          }
        }

        await pty.startSession(sessionId ?? undefined, workingDir);
        const dirInfo = workingDir ? ` (📁 ${workingDir})` : "";
        const msg = sessionId
          ? `✅ セッション \`${sessionId.slice(0, 8)}...\` を再開しました${dirInfo}`
          : `✅ 最新のセッションを開始しました${dirInfo}`;
        await interaction.editReply(msg);
      } catch (error) {
        logger.error({ error }, "Failed to start session");
        await interaction.editReply("❌ セッション開始に失敗しました");
      }
    }
  );

  // Start session from Select Menu or Button (thread-aware)
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

        // Get project path from thread if in a thread
        const threadManager = discord.getThreadManager();
        const channel = interaction.channel;
        let workingDir: string | undefined;

        if (channel?.isThread()) {
          const projectPath = await threadManager.getProjectPathFromThreadAsync(channel);
          if (projectPath) {
            workingDir = projectPath;
          }
        }

        await pty.startSession(sessionId ?? undefined, workingDir);
        const dirInfo = workingDir ? ` (📁 ${workingDir})` : "";
        const msg = sessionId
          ? `✅ セッション \`${sessionId.slice(0, 8)}...\` を再開しました${dirInfo}`
          : `✅ 最新のセッションを開始しました${dirInfo}`;
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

  // /takeover - Take over session from VSCode (thread-aware)
  discord.on(
    "command:takeover",
    async (sessionId: string, interaction: ChatInputCommandInteraction) => {
      try {
        if (pty.isRunning) {
          await interaction.editReply("⚠️ 既にPTYセッションが実行中です。先に `/stop` してください");
          return;
        }

        // Get project path from thread if in a thread
        const threadManager = discord.getThreadManager();
        const channel = interaction.channel;
        let workingDir: string | undefined;

        if (channel?.isThread()) {
          const projectPath = await threadManager.getProjectPathFromThreadAsync(channel);
          if (projectPath) {
            workingDir = projectPath;
          }
        }

        const { killed } = await pty.takeoverSession(sessionId, workingDir);
        const dirInfo = workingDir ? ` (📁 ${workingDir})` : "";
        const killedInfo = killed > 0 ? `\n🔪 ${killed}個のプロセスを終了しました` : "";
        await interaction.editReply(
          `✅ セッション \`${sessionId.slice(0, 8)}...\` を引き継ぎました${dirInfo}${killedInfo}`
        );
      } catch (error) {
        logger.error({ error }, "Failed to takeover session");
        await interaction.editReply("❌ セッション引き継ぎに失敗しました");
      }
    }
  );

  // /mode - Change approval mode (thread-aware)
  discord.on(
    "command:mode",
    async (mode: string | null, interaction: ChatInputCommandInteraction) => {
      try {
        const threadManager = discord.getThreadManager();
        const channel = interaction.channel;
        const isThread = channel?.isThread();

        // Get project path if in a thread (async to recover from restart)
        let projectPath: string | null = null;
        if (isThread && channel) {
          projectPath = await threadManager.getProjectPathFromThreadAsync(channel);
        }

        if (mode) {
          if (mode === "clear" && projectPath) {
            // Clear project-specific mode
            clearProjectMode(projectPath);
            const globalMode = getApprovalMode();
            await interaction.editReply({
              embeds: [
                {
                  title: "🗑️ プロジェクト設定をクリア",
                  description: `このプロジェクトの個別設定を削除しました。\nグローバル設定 (${getModeDescription(globalMode)}) が適用されます。`,
                  color: 0x6b7280,
                },
              ],
            });
          } else if (projectPath) {
            // Set project-specific mode
            setProjectMode(projectPath, mode as ApprovalMode);
            await interaction.editReply({
              embeds: [
                {
                  title: "✅ プロジェクトモードを変更",
                  description: getModeDescription(mode as ApprovalMode),
                  fields: [
                    { name: "📁 プロジェクト", value: `\`${projectPath}\``, inline: false },
                  ],
                  color: 0x22c55e,
                },
              ],
            });
          } else {
            // Set global mode
            setApprovalMode(mode as ApprovalMode);
            await interaction.editReply({
              embeds: [
                {
                  title: "✅ グローバルモードを変更",
                  description: getModeDescription(mode as ApprovalMode),
                  footer: { text: "全プロジェクトに適用（個別設定がない場合）" },
                  color: 0x22c55e,
                },
              ],
            });
          }
        } else {
          // Show current mode
          const globalMode = getApprovalMode();

          if (projectPath) {
            const projectMode = getProjectMode(projectPath);
            const effectiveMode = projectMode ?? globalMode;
            await interaction.editReply({
              embeds: [
                {
                  title: "⚙️ 承認モード設定",
                  fields: [
                    {
                      name: "📁 このプロジェクト",
                      value: projectMode
                        ? getModeDescription(projectMode)
                        : "（グローバル設定を使用）",
                      inline: false
                    },
                    { name: "🌐 グローバル", value: getModeDescription(globalMode), inline: false },
                    { name: "▶️ 適用中", value: getModeDescription(effectiveMode), inline: false },
                  ],
                  footer: { text: "プロジェクト設定を削除: /mode clear" },
                  color: 0x3b82f6,
                },
              ],
            });
          } else {
            await interaction.editReply({
              embeds: [
                {
                  title: "⚙️ グローバル承認モード",
                  description: getModeDescription(globalMode),
                  fields: [
                    { name: "🔔 discord", value: "Discord経由で承認", inline: true },
                    { name: "🖥️ vscode", value: "VSCodeのUI", inline: true },
                    { name: "⚡ auto", value: "全自動承認", inline: true },
                  ],
                  footer: { text: "スレッド内で実行するとプロジェクト別設定" },
                  color: 0x3b82f6,
                },
              ],
            });
          }
        }
      } catch (error) {
        logger.error({ error }, "Failed to change mode");
        await interaction.editReply("❌ モード変更に失敗しました");
      }
    }
  );

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
