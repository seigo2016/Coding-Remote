import { randomUUID } from "crypto";
import type { ChatInputCommandInteraction } from "discord.js";
import { TmuxManager } from "../tmux/manager.js";
import { DiscordBot } from "../discord/client.js";
import { ClaudeOutputParser } from "../parser/claude-output.js";
import { formatDiffForDiscord } from "../parser/diff-formatter.js";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { ApprovalAction } from "../discord/types.js";
import type { SessionState, SessionInfo } from "./types.js";
import type { ClaudeState } from "../parser/types.js";

const logger = createChildLogger("orchestrator");

export class SessionOrchestrator {
  private tmux: TmuxManager;
  private discord: DiscordBot;
  private parser: ClaudeOutputParser;

  private sessionInfo: SessionInfo;
  private _isRunning = false;
  private pendingApproval: string | null = null;

  constructor(tmux: TmuxManager, discord: DiscordBot) {
    this.tmux = tmux;
    this.discord = discord;
    this.parser = new ClaudeOutputParser();

    this.sessionInfo = {
      id: randomUUID(),
      state: "idle",
      workingDir: config.claude.workingDir,
      approvalMode: "ask",
    };

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Discord command handlers
    this.discord.on("command:ask", this.handleAskCommand.bind(this));
    this.discord.on("command:status", this.handleStatusCommand.bind(this));
    this.discord.on("command:output", this.handleOutputCommand.bind(this));
    this.discord.on("command:resume", this.handleResumeCommand.bind(this));
    this.discord.on("command:abort", this.handleAbortCommand.bind(this));
    this.discord.on("command:send", this.handleSendCommand.bind(this));

    // Tmux output handler
    this.tmux.on("output", this.handleTmuxOutput.bind(this));
    this.tmux.on("error", (error) => {
      logger.error({ error }, "Tmux error");
      this.updateState("error");
    });
  }

  async start(): Promise<void> {
    logger.info("Starting orchestrator...");

    // Check tmux availability
    const tmuxAvailable = await this.tmux.checkTmuxAvailable();
    if (!tmuxAvailable) {
      throw new Error("tmux is not available on this system");
    }

    // Connect to Discord
    await this.discord.connect();
    await this.discord.registerCommands();

    // Check for existing tmux session
    const status = await this.tmux.getSessionStatus();
    if (status !== "not_found") {
      logger.info({ status }, "Found existing tmux session");
      this.updateState("running");
      this.tmux.startPolling();
    }

    this._isRunning = true;
    await this.discord.sendNotification("🤖 Bot is online and ready", "success");
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down orchestrator...");

    this.tmux.stopPolling();
    await this.discord.sendNotification("👋 Bot is shutting down", "info");
    await this.discord.disconnect();

    this._isRunning = false;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  private async handleAskCommand(
    prompt: string,
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    logger.info({ prompt }, "Received ask command");

    try {
      // Ensure session exists
      await this.ensureSession();

      // Send the prompt
      await this.tmux.sendKeys(prompt);
      await this.tmux.sendKeys("Enter", true);

      this.updateState("running");
      this.sessionInfo.lastActivity = new Date();

      await interaction.editReply({
        content: `📤 プロンプトを送信しました:\n\`\`\`\n${prompt}\n\`\`\``,
      });

      // Start polling if not already
      this.tmux.startPolling();
    } catch (error) {
      logger.error({ error }, "Failed to handle ask command");
      await interaction.editReply({
        content: `❌ エラーが発生しました: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  private async handleStatusCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const tmuxStatus = await this.tmux.getSessionStatus();
    const sessions = await this.tmux.listSessions();

    const statusEmoji = {
      idle: "💤",
      starting: "🚀",
      running: "🏃",
      awaiting_approval: "⏳",
      paused: "⏸️",
      stopped: "⏹️",
      error: "❌",
    };

    let content = `**セッション状態**\n`;
    content += `状態: ${statusEmoji[this.sessionInfo.state]} ${this.sessionInfo.state}\n`;
    content += `tmux: ${tmuxStatus}\n`;
    content += `作業ディレクトリ: \`${this.sessionInfo.workingDir}\`\n`;
    content += `承認モード: ${this.sessionInfo.approvalMode}\n`;

    if (this.sessionInfo.startedAt) {
      content += `開始時刻: ${this.sessionInfo.startedAt.toLocaleString()}\n`;
    }

    if (sessions.length > 0) {
      content += `\n**tmuxセッション一覧**\n`;
      for (const session of sessions) {
        const attachedIcon = session.attached ? "📎" : "";
        content += `- ${session.name} ${attachedIcon} (windows: ${session.windows})\n`;
      }
    }

    await interaction.editReply({ content });
  }

  private async handleOutputCommand(
    lines: number,
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    try {
      const output = await this.tmux.capturePane({ start: -lines });

      if (!output.trim()) {
        await interaction.editReply({ content: "📭 出力がありません" });
        return;
      }

      // Truncate for Discord message limit
      const truncated =
        output.length > 1800 ? output.slice(-1800) + "\n..." : output;

      await interaction.editReply({
        content: `**最新の出力 (${lines}行)**\n\`\`\`\n${truncated}\n\`\`\``,
      });
    } catch (error) {
      await interaction.editReply({
        content: `❌ 出力の取得に失敗しました: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  private async handleResumeCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    try {
      await this.ensureSession();
      await this.tmux.resumeClaudeCode();

      this.updateState("running");
      this.tmux.startPolling();

      await interaction.editReply({
        content: "▶️ 前回のセッションを再開しました",
      });
    } catch (error) {
      await interaction.editReply({
        content: `❌ 再開に失敗しました: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  private async handleAbortCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    try {
      // Send Ctrl+C
      await this.tmux.sendKeys("C-c", true);

      this.updateState("stopped");

      await interaction.editReply({
        content: "🛑 操作を中断しました",
      });
    } catch (error) {
      await interaction.editReply({
        content: `❌ 中断に失敗しました: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  private async handleSendCommand(
    input: string,
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    try {
      await this.tmux.sendKeys(input);
      await this.tmux.sendKeys("Enter", true);

      await interaction.editReply({
        content: `📤 送信しました: \`${input}\``,
      });
    } catch (error) {
      await interaction.editReply({
        content: `❌ 送信に失敗しました: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  private async handleTmuxOutput(_newContent: string, fullOutput: string): Promise<void> {
    const parsed = this.parser.parse(fullOutput);

    logger.debug({ state: parsed.state }, "Parsed output state");

    // Handle state transitions
    if (parsed.state !== this.sessionInfo.state) {
      await this.handleStateChange(parsed.state, parsed);
    }

    this.parser.updateState(parsed.state);
  }

  private async handleStateChange(
    newState: ClaudeState,
    parsed: ReturnType<ClaudeOutputParser["parse"]>
  ): Promise<void> {
    const previousState = this.sessionInfo.state;

    switch (newState) {
      case "awaiting_approval":
        if (this.sessionInfo.approvalMode === "auto_approve") {
          await this.sendApprovalResponse("y");
        } else if (this.sessionInfo.approvalMode === "auto_reject") {
          await this.sendApprovalResponse("n");
        } else if (parsed.approval) {
          this.updateState("awaiting_approval");
          await this.requestApproval(parsed.approval);
        }
        break;

      case "completed":
        this.updateState("idle");
        await this.discord.sendNotification("✅ タスクが完了しました", "success");
        break;

      case "error":
        this.updateState("error");
        await this.discord.sendNotification(
          `❌ エラーが発生しました: ${parsed.error ?? "Unknown error"}`,
          "error"
        );
        break;

      case "thinking":
      case "executing":
        if (previousState !== "running") {
          this.updateState("running");
        }
        break;

      default:
        break;
    }
  }

  private async requestApproval(
    approval: NonNullable<ReturnType<ClaudeOutputParser["parse"]>["approval"]>
  ): Promise<void> {
    if (this.pendingApproval) {
      logger.warn("Already have pending approval, skipping");
      return;
    }

    const requestId = randomUUID().slice(0, 8);
    this.pendingApproval = requestId;

    const details = approval.diff
      ? formatDiffForDiscord(approval.diff)
      : approval.command ?? approval.description;

    try {
      const action = await this.discord.sendApprovalRequest({
        id: requestId,
        toolName: approval.toolName,
        description: approval.filePath ?? approval.command ?? approval.description,
        details,
        timestamp: new Date(),
      });

      await this.handleApprovalAction(action);
    } finally {
      this.pendingApproval = null;
    }
  }

  private async handleApprovalAction(action: ApprovalAction): Promise<void> {
    switch (action) {
      case ApprovalAction.Approve:
        await this.sendApprovalResponse("y");
        this.updateState("running");
        break;

      case ApprovalAction.Reject:
        await this.sendApprovalResponse("n");
        this.updateState("running");
        break;

      case ApprovalAction.ApproveAll:
        this.sessionInfo.approvalMode = "auto_approve";
        await this.sendApprovalResponse("y");
        this.updateState("running");
        await this.discord.sendNotification(
          "📋 以降の承認は自動的に許可されます",
          "info"
        );
        break;

      case ApprovalAction.Abort:
        await this.tmux.sendKeys("C-c", true);
        this.updateState("stopped");
        break;
    }
  }

  private async sendApprovalResponse(response: "y" | "n"): Promise<void> {
    await this.tmux.sendKeys(response);
    await this.tmux.sendKeys("Enter", true);
  }

  private async ensureSession(): Promise<void> {
    const status = await this.tmux.getSessionStatus();

    if (status === "not_found") {
      await this.tmux.createSession(this.sessionInfo.workingDir);
      this.sessionInfo.startedAt = new Date();
      this.updateState("starting");
    }
  }

  private updateState(state: SessionState): void {
    if (this.sessionInfo.state !== state) {
      logger.info({ from: this.sessionInfo.state, to: state }, "State change");
      this.sessionInfo.state = state;
    }
  }
}
