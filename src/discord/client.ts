import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type TextChannel,
  type Message,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { EventEmitter } from "events";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { ApprovalAction, type ToolApprovalRequest } from "./types.js";
import type { ClaudeSession } from "../pty/types.js";

const logger = createChildLogger("discord");

// Session cache for autocomplete
let sessionCache: ClaudeSession[] = [];

export class DiscordBot extends EventEmitter {
  private client: Client;
  private rest: REST;
  private channel: TextChannel | null = null;
  private ready = false;
  private outputPages: Map<string, { pages: string[]; currentPage: number }> = new Map();

  constructor() {
    super();

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.botToken);

    this.setupEventHandlers();
  }

  /**
   * Update session cache for autocomplete
   */
  updateSessionCache(sessions: ClaudeSession[]): void {
    sessionCache = sessions;
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      logger.info({ user: this.client.user?.tag }, "Discord bot is ready");

      try {
        const channel = await this.client.channels.fetch(config.discord.channelId);
        if (channel?.isTextBased()) {
          this.channel = channel as TextChannel;
        }
      } catch (error) {
        logger.error({ error }, "Failed to fetch channel");
      }

      this.ready = true;
    });

    this.client.on("interactionCreate", async (interaction) => {
      // Verify owner for all interactions
      if (interaction.user.id !== config.discord.ownerId) {
        if (interaction.isRepliable()) {
          await interaction.reply({
            content: "⛔ You are not authorized to use this bot.",
            ephemeral: true,
          });
        }
        return;
      }

      // Handle different interaction types
      if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
      } else if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
      } else if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenu(interaction);
      } else if (interaction.isButton()) {
        // Skip approval buttons - they are handled by the collector in waitForApproval
        const customId = interaction.customId;
        const action = customId.split(":")[0];
        if (Object.values(ApprovalAction).includes(action as ApprovalAction)) {
          // Let the message collector handle this
          return;
        }
        await this.handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      }
    });

    this.client.on("error", (error) => {
      logger.error({ error }, "Discord client error");
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "sessions":
          await interaction.deferReply();
          this.emit("command:sessions", interaction);
          break;

        case "continue": {
          await interaction.deferReply();
          const sessionId = interaction.options.getString("session_id");
          this.emit("command:continue", sessionId, interaction);
          break;
        }

        case "ask": {
          // Show modal for longer input
          const modal = new ModalBuilder()
            .setCustomId("ask_modal")
            .setTitle("Claude Code にプロンプトを送信");

          const promptInput = new TextInputBuilder()
            .setCustomId("prompt_input")
            .setLabel("プロンプト")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Claude に送信するプロンプトを入力...")
            .setRequired(true)
            .setMaxLength(4000);

          const row = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
          modal.addComponents(row);

          await interaction.showModal(modal);
          break;
        }

        case "output": {
          await interaction.deferReply();
          const lines = interaction.options.getInteger("lines") ?? 50;
          this.emit("command:output", lines, interaction);
          break;
        }

        case "stop":
          await interaction.deferReply();
          this.emit("command:stop", interaction);
          break;

        case "status":
          await interaction.deferReply();
          this.emit("command:status", interaction);
          break;

        case "mode": {
          await interaction.deferReply();
          const mode = interaction.options.getString("mode");
          this.emit("command:mode", mode, interaction);
          break;
        }

        default:
          await interaction.reply({ content: "Unknown command", ephemeral: true });
      }
    } catch (error) {
      logger.error({ error, command: commandName }, "Command error");
      const content = "❌ コマンドの実行中にエラーが発生しました";
      if (interaction.deferred) {
        await interaction.editReply({ content });
      } else if (!interaction.replied) {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "session_id") {
      const query = focusedOption.value.toLowerCase();
      const filtered = sessionCache
        .filter(
          (s) =>
            s.id.toLowerCase().includes(query) ||
            s.projectPath.toLowerCase().includes(query) ||
            s.summary?.toLowerCase().includes(query)
        )
        .slice(0, 25)
        .map((s) => ({
          name: `${s.projectPath.split("/").pop()} - ${s.summary?.slice(0, 40) || s.id.slice(0, 8)}`,
          value: s.id,
        }));

      await interaction.respond(filtered);
    }
  }

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const [action, ...rest] = interaction.customId.split(":");

    if (action === "session_select") {
      const sessionId = interaction.values[0];
      await interaction.deferUpdate();

      // Update the message to show loading
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔄 セッション開始中...")
            .setDescription(`セッション \`${sessionId}\` を開始しています...`)
            .setColor(0x3b82f6),
        ],
        components: [],
      });

      this.emit("command:continue:select", sessionId, interaction);
    } else if (action === "output_page") {
      const messageId = rest.join(":");
      const pageData = this.outputPages.get(messageId);
      if (!pageData) return;

      const selectedValue = interaction.values[0];
      if (!selectedValue) return;

      const newPage = parseInt(selectedValue, 10);
      pageData.currentPage = newPage;

      await this.updateOutputPage(interaction, pageData.pages, newPage, messageId);
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [action, ...rest] = interaction.customId.split(":");

    // Approval buttons
    if (Object.values(ApprovalAction).includes(action as ApprovalAction)) {
      // Handled by waitForApproval collector
      return;
    }

    // Session list buttons
    if (action === "session_refresh") {
      await interaction.deferUpdate();
      this.emit("command:sessions:refresh", interaction);
      return;
    }

    if (action === "session_start_latest") {
      await interaction.deferUpdate();
      this.emit("command:continue:select", null, interaction);
      return;
    }

    // Output pagination buttons
    if (action === "output_prev" || action === "output_next") {
      const messageId = rest.join(":");
      const pageData = this.outputPages.get(messageId);
      if (!pageData) return;

      const newPage =
        action === "output_prev"
          ? Math.max(0, pageData.currentPage - 1)
          : Math.min(pageData.pages.length - 1, pageData.currentPage + 1);

      if (newPage !== pageData.currentPage) {
        pageData.currentPage = newPage;
        await this.updateOutputPage(interaction, pageData.pages, newPage, messageId);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Quick action buttons
    if (action === "quick_stop") {
      await interaction.deferUpdate();
      this.emit("command:stop:quick", interaction);
      return;
    }

    if (action === "quick_output") {
      await interaction.deferUpdate();
      this.emit("command:output:quick", 50, interaction);
      return;
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId === "ask_modal") {
      await interaction.deferReply();
      const prompt = interaction.fields.getTextInputValue("prompt_input");
      this.emit("command:ask", prompt, interaction);
    }
  }

  private async updateOutputPage(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    pages: string[],
    currentPage: number,
    messageId: string
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle(`📄 Claude Code 出力`)
      .setDescription(`\`\`\`ansi\n${pages[currentPage]}\n\`\`\``)
      .setColor(0x3b82f6)
      .setFooter({ text: `ページ ${currentPage + 1}/${pages.length}` })
      .setTimestamp();

    const row = this.buildPaginationButtons(currentPage, pages.length, messageId);

    await interaction.update({ embeds: [embed], components: [row] });
  }

  private buildPaginationButtons(
    currentPage: number,
    totalPages: number,
    messageId: string
  ): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`output_prev:${messageId}`)
        .setLabel("◀ 前へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId("page_indicator")
        .setLabel(`${currentPage + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`output_next:${messageId}`)
        .setLabel("次へ ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalPages - 1)
    );
  }

  async connect(): Promise<void> {
    await this.client.login(config.discord.botToken);

    while (!this.ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("sessions")
        .setDescription("セッション一覧を表示（Select Menuで選択可能）"),

      new SlashCommandBuilder()
        .setName("continue")
        .setDescription("CLIセッションを開始")
        .addStringOption((opt) =>
          opt
            .setName("session_id")
            .setDescription("再開するセッションID（省略時は最新）")
            .setRequired(false)
            .setAutocomplete(true)
        ),

      new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Claude Code にプロンプトを送信（モーダル入力）"),

      new SlashCommandBuilder()
        .setName("output")
        .setDescription("最新の出力を表示（ページネーション付き）")
        .addIntegerOption((opt) =>
          opt
            .setName("lines")
            .setDescription("表示する行数（デフォルト: 50）")
            .setRequired(false)
            .setMinValue(10)
            .setMaxValue(500)
        ),

      new SlashCommandBuilder().setName("stop").setDescription("CLIセッションを停止"),

      new SlashCommandBuilder().setName("status").setDescription("セッション状態を表示"),

      new SlashCommandBuilder()
        .setName("mode")
        .setDescription("承認モードを切り替え")
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("承認モード")
            .setRequired(false)
            .addChoices(
              { name: "🔔 Discord承認", value: "discord" },
              { name: "🖥️ VSCode UI", value: "vscode" },
              { name: "⚡ 自動承認", value: "auto" }
            )
        ),
    ];

    try {
      // Use guild commands for instant updates (no 1-hour delay)
      const guildId = this.channel?.guild?.id;
      if (guildId) {
        await this.rest.put(Routes.applicationGuildCommands(this.client.user!.id, guildId), {
          body: commands.map((c) => c.toJSON()),
        });
        logger.info({ count: commands.length, guildId }, "Registered guild slash commands");
      } else {
        // Fallback to global commands
        await this.rest.put(Routes.applicationCommands(this.client.user!.id), {
          body: commands.map((c) => c.toJSON()),
        });
        logger.info({ count: commands.length }, "Registered global slash commands");
      }
    } catch (error) {
      logger.error({ error }, "Failed to register commands");
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    logger.info("Discord bot disconnected");
  }

  /**
   * Build session list with Select Menu and Buttons
   */
  buildSessionListComponents(
    sessions: ClaudeSession[]
  ): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
  } {
    const embed = new EmbedBuilder()
      .setTitle("📋 Claude Code セッション一覧")
      .setColor(0x3b82f6)
      .setDescription(
        sessions.length === 0
          ? "セッションが見つかりません"
          : `${sessions.length}件のセッションが見つかりました`
      )
      .setTimestamp();

    if (sessions.length === 0) {
      return { embeds: [embed], components: [] };
    }

    // Add fields for top sessions
    const displaySessions = sessions.slice(0, 5);
    for (const session of displaySessions) {
      const projectName = session.projectPath.split("/").pop() || session.projectPath;
      const date = session.lastModified.toLocaleString("ja-JP", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      embed.addFields({
        name: `📁 ${projectName}`,
        value:
          `ID: \`${session.id.slice(0, 8)}...\`\n` +
          `🕐 ${date}\n` +
          (session.summary ? `💬 ${session.summary.slice(0, 60)}...` : ""),
        inline: true,
      });
    }

    // Build Select Menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("session_select")
      .setPlaceholder("🔍 セッションを選択...")
      .addOptions(
        sessions.slice(0, 25).map((s) => ({
          label: s.projectPath.split("/").pop() || s.id.slice(0, 8),
          description: s.summary?.slice(0, 50) || `最終更新: ${s.lastModified.toLocaleDateString("ja-JP")}`,
          value: s.id,
          emoji: "📁",
        }))
      );

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    // Build action buttons
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("session_start_latest")
        .setLabel("🚀 最新を開始")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("session_refresh")
        .setLabel("🔄 更新")
        .setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [selectRow, buttonRow],
    };
  }

  /**
   * Build paginated output with buttons
   */
  async sendPaginatedOutput(
    content: string,
    interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction
  ): Promise<void> {
    const pages = this.splitMessage(content, 1800);
    const messageId = `output_${Date.now()}`;

    this.outputPages.set(messageId, { pages, currentPage: 0 });

    // Clean up old pages after 10 minutes
    setTimeout(() => this.outputPages.delete(messageId), 600000);

    const embed = new EmbedBuilder()
      .setTitle("📄 Claude Code 出力")
      .setDescription(`\`\`\`ansi\n${pages[0]}\n\`\`\``)
      .setColor(0x3b82f6)
      .setFooter({ text: `ページ 1/${pages.length}` })
      .setTimestamp();

    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (pages.length > 1) {
      components.push(this.buildPaginationButtons(0, pages.length, messageId));
    }

    // Add quick action buttons
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("quick_output")
          .setLabel("🔄 更新")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("quick_stop")
          .setLabel("🛑 停止")
          .setStyle(ButtonStyle.Danger)
      )
    );

    if (interaction.isCommand()) {
      await interaction.editReply({ embeds: [embed], components });
    } else {
      await (interaction as ButtonInteraction | StringSelectMenuInteraction).editReply({
        embeds: [embed],
        components,
      });
    }
  }

  /**
   * Build status embed with action buttons
   */
  buildStatusEmbed(status: {
    isRunning: boolean;
    sessionId?: string;
    startedAt?: Date;
    workingDir: string;
    bufferSize: number;
  }): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const statusIcon = status.isRunning ? "🟢" : "⚪";
    const statusText = status.isRunning ? "実行中" : "停止中";

    const embed = new EmbedBuilder()
      .setTitle(`${statusIcon} セッション状態: ${statusText}`)
      .setColor(status.isRunning ? 0x22c55e : 0x6b7280)
      .addFields(
        { name: "📁 作業ディレクトリ", value: `\`${status.workingDir}\``, inline: false },
        { name: "📊 出力バッファ", value: `${status.bufferSize.toLocaleString()} 文字`, inline: true }
      )
      .setTimestamp();

    if (status.sessionId) {
      embed.addFields({ name: "🔑 セッションID", value: `\`${status.sessionId}\``, inline: true });
    }

    if (status.startedAt) {
      embed.addFields({
        name: "🕐 開始時刻",
        value: status.startedAt.toLocaleString("ja-JP"),
        inline: true,
      });
    }

    const buttons = new ActionRowBuilder<ButtonBuilder>();

    if (status.isRunning) {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId("quick_output")
          .setLabel("📄 出力を表示")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("quick_stop")
          .setLabel("🛑 停止")
          .setStyle(ButtonStyle.Danger)
      );
    } else {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId("session_start_latest")
          .setLabel("🚀 セッション開始")
          .setStyle(ButtonStyle.Success)
      );
    }

    return { embeds: [embed], components: [buttons] };
  }

  async requestApproval(request: ToolApprovalRequest): Promise<ApprovalAction> {
    if (!this.channel) {
      logger.warn("No channel available, auto-approving");
      return ApprovalAction.Approve;
    }

    const embed = this.buildApprovalEmbed(request);
    const row = this.buildApprovalButtons(request.id);

    const message = await this.channel.send({ embeds: [embed], components: [row] });

    return this.waitForApproval(message, embed);
  }

  private buildApprovalEmbed(request: ToolApprovalRequest): EmbedBuilder {
    const toolIcons: Record<string, string> = {
      Edit: "✏️",
      Write: "📝",
      Bash: "💻",
      Read: "📖",
      Delete: "🗑️",
      default: "🔧",
    };

    const icon = toolIcons[request.tool] || toolIcons.default;

    const embed = new EmbedBuilder()
      .setTitle(`${icon} ツール実行の承認`)
      .setColor(0xf59e0b)
      .addFields({ name: "ツール", value: `\`${request.tool}\``, inline: true })
      .setTimestamp(request.timestamp);

    const inputStr = this.formatToolInput(request.tool, request.input);
    if (inputStr) {
      const truncated = inputStr.length > 1000 ? inputStr.slice(0, 997) + "..." : inputStr;
      embed.addFields({ name: "詳細", value: `\`\`\`\n${truncated}\n\`\`\`` });
    }

    return embed;
  }

  private formatToolInput(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case "Edit":
      case "Write":
        return `File: ${input["file_path"] ?? "unknown"}\n${input["content"] ? "..." : ""}`;

      case "Bash":
        return `$ ${input["command"] ?? ""}`;

      case "Read":
        return `File: ${input["file_path"] ?? "unknown"}`;

      default:
        return JSON.stringify(input, null, 2);
    }
  }

  private buildApprovalButtons(requestId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Approve}:${requestId}`)
        .setLabel("許可")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Reject}:${requestId}`)
        .setLabel("拒否")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.ApproveAll}:${requestId}`)
        .setLabel("全て許可")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Abort}:${requestId}`)
        .setLabel("中断")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🛑")
    );
  }

  private waitForApproval(message: Message, embed: EmbedBuilder): Promise<ApprovalAction> {
    return new Promise((resolve) => {
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: config.approval.timeoutMs,
        filter: (i) => i.user.id === config.discord.ownerId,
      });

      collector.on("collect", async (interaction) => {
        try {
          const [action] = interaction.customId.split(":") as [ApprovalAction, string];
          logger.info({ action }, "Approval button clicked");

          const resultColor =
            action === ApprovalAction.Approve || action === ApprovalAction.ApproveAll
              ? 0x22c55e
              : 0xef4444;

          await interaction.update({
            components: [],
            embeds: [
              EmbedBuilder.from(embed)
                .setColor(resultColor)
                .addFields({ name: "結果", value: this.getActionLabel(action) }),
            ],
          });

          logger.info({ action }, "Approval response sent");
          collector.stop();
          resolve(action);
        } catch (error) {
          logger.error({ error }, "Error handling approval button");
          // Still resolve to prevent hanging
          resolve(ApprovalAction.Approve);
        }
      });

      collector.on("end", (_collected, reason) => {
        logger.info({ reason }, "Approval collector ended");
        if (reason === "time") {
          const defaultAction =
            config.approval.defaultAction === "approve"
              ? ApprovalAction.Approve
              : ApprovalAction.Reject;

          message.edit({
            components: [],
            embeds: [
              EmbedBuilder.from(embed)
                .setColor(defaultAction === ApprovalAction.Approve ? 0x22c55e : 0x6b7280)
                .addFields({
                  name: "結果",
                  value: `⏰ タイムアウト（自動${defaultAction === ApprovalAction.Approve ? "許可" : "拒否"}）`,
                }),
            ],
          });

          resolve(defaultAction);
        }
      });
    });
  }

  private getActionLabel(action: ApprovalAction): string {
    switch (action) {
      case ApprovalAction.Approve:
        return "✅ 許可されました";
      case ApprovalAction.Reject:
        return "❌ 拒否されました";
      case ApprovalAction.ApproveAll:
        return "📋 全て許可されました";
      case ApprovalAction.Abort:
        return "🛑 中断されました";
    }
  }

  async sendNotification(
    text: string,
    type: "info" | "success" | "warning" | "error" = "info"
  ): Promise<void> {
    if (!this.channel) return;

    const colors = {
      info: 0x3b82f6,
      success: 0x22c55e,
      warning: 0xf59e0b,
      error: 0xef4444,
    };

    const icons = {
      info: "ℹ️",
      success: "✅",
      warning: "⚠️",
      error: "❌",
    };

    const embed = new EmbedBuilder()
      .setDescription(`${icons[type]} ${text}`)
      .setColor(colors[type])
      .setTimestamp();

    await this.channel.send({ embeds: [embed] });
  }

  private splitMessage(content: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let current = "";

    for (const line of content.split("\n")) {
      if (current.length + line.length + 1 > maxLength) {
        if (current) chunks.push(current);
        current = line.length > maxLength ? line.slice(0, maxLength) : line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }

    if (current) chunks.push(current);
    return chunks.length ? chunks : ["(empty)"];
  }
}
