import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  REST,
  Routes,
  SlashCommandBuilder,
  type TextChannel,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import { EventEmitter } from "events";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { ApprovalAction, type ToolApprovalRequest } from "./types.js";

const logger = createChildLogger("discord");

export class DiscordBot extends EventEmitter {
  private client: Client;
  private rest: REST;
  private channel: TextChannel | null = null;
  private ready = false;

  constructor() {
    super();

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.botToken);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      logger.info({ user: this.client.user?.tag }, "Discord bot is ready");

      // Fetch the channel
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
      if (!interaction.isChatInputCommand()) return;

      // Verify owner
      if (interaction.user.id !== config.discord.ownerId) {
        await interaction.reply({
          content: "⛔ You are not authorized to use this bot.",
          ephemeral: true,
        });
        return;
      }

      await this.handleCommand(interaction);
    });

    this.client.on("error", (error) => {
      logger.error({ error }, "Discord client error");
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "continue":
          await interaction.deferReply();
          this.emit("command:continue", interaction);
          break;

        case "ask": {
          await interaction.deferReply();
          const prompt = interaction.options.getString("prompt", true);
          this.emit("command:ask", prompt, interaction);
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

        default:
          await interaction.reply({ content: "Unknown command", ephemeral: true });
      }
    } catch (error) {
      logger.error({ error, command: commandName }, "Command error");
      const content = "❌ An error occurred while executing the command.";
      if (interaction.deferred) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  async connect(): Promise<void> {
    await this.client.login(config.discord.botToken);

    // Wait for ready
    while (!this.ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("continue")
        .setDescription("Start CLI session to continue from VSCode"),

      new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Send a prompt to Claude Code")
        .addStringOption((opt) =>
          opt.setName("prompt").setDescription("The prompt to send").setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName("output")
        .setDescription("Show recent Claude Code output")
        .addIntegerOption((opt) =>
          opt.setName("lines").setDescription("Number of lines (default: 50)").setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop the CLI session"),

      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show current session status"),
    ];

    try {
      await this.rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commands.map((c) => c.toJSON()),
      });
      logger.info({ count: commands.length }, "Registered slash commands");
    } catch (error) {
      logger.error({ error }, "Failed to register commands");
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    logger.info("Discord bot disconnected");
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
    const embed = new EmbedBuilder()
      .setTitle("🔧 ツール実行の承認")
      .setColor(0xf59e0b)
      .addFields({ name: "ツール", value: `\`${request.tool}\``, inline: true })
      .setTimestamp(request.timestamp);

    // Format input based on tool type
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
        const [action] = interaction.customId.split(":") as [ApprovalAction, string];

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

        collector.stop();
        resolve(action);
      });

      collector.on("end", (_collected, reason) => {
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

  async sendOutput(content: string, title = "Claude Code 出力"): Promise<void> {
    if (!this.channel) return;

    const chunks = this.splitMessage(content, 1900);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      const embed = new EmbedBuilder()
        .setTitle(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title)
        .setDescription(`\`\`\`\n${chunk}\n\`\`\``)
        .setColor(0x3b82f6)
        .setTimestamp();

      await this.channel.send({ embeds: [embed] });
    }
  }

  private splitMessage(content: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let current = "";

    for (const line of content.split("\n")) {
      if (current.length + line.length + 1 > maxLength) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }

    if (current) chunks.push(current);
    return chunks.length ? chunks : ["(empty)"];
  }
}
