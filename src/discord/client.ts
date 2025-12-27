import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type TextChannel,
  type Message,
} from "discord.js";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { ApprovalAction, type ToolApprovalRequest } from "./types.js";

const logger = createChildLogger("discord");

export class DiscordBot {
  private client: Client;
  private channel: TextChannel | null = null;
  private ready = false;

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

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

    this.client.on("error", (error) => {
      logger.error({ error }, "Discord client error");
    });
  }

  async connect(): Promise<void> {
    await this.client.login(config.discord.botToken);

    // Wait for ready
    while (!this.ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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

    return this.waitForApproval(message, embed, request.id);
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

  private waitForApproval(
    message: Message,
    embed: EmbedBuilder,
    _requestId: string
  ): Promise<ApprovalAction> {
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
}
