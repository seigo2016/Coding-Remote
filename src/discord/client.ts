import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type TextChannel,
  type Interaction,
  type Message,
} from "discord.js";
import { EventEmitter } from "events";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { DiscordError } from "../utils/error.js";
import { ApprovalAction, type ApprovalRequest, type CommandDefinition } from "./types.js";

const logger = createChildLogger("discord");

export class DiscordBot extends EventEmitter {
  private client: Client;
  private rest: REST;
  private commands: Map<string, CommandDefinition> = new Map();
  private channel: TextChannel | null = null;

  constructor() {
    super();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.botToken);

    this.setupEventHandlers();
    this.registerDefaultCommands();
  }

  private setupEventHandlers(): void {
    this.client.once("ready", () => {
      logger.info({ user: this.client.user?.tag }, "Discord bot is ready");
      this.emit("ready");
    });

    this.client.on("interactionCreate", async (interaction) => {
      await this.handleInteraction(interaction);
    });

    this.client.on("error", (error) => {
      logger.error({ error }, "Discord client error");
      this.emit("error", error);
    });
  }

  private registerDefaultCommands(): void {
    this.commands.set("ask", {
      name: "ask",
      description: "Send a prompt to Claude Code",
      options: [
        {
          name: "prompt",
          description: "The prompt to send to Claude",
          type: "string",
          required: true,
        },
      ],
      handler: async (interaction) => {
        const prompt = interaction.options.getString("prompt", true);
        await interaction.deferReply();
        this.emit("command:ask", prompt, interaction);
      },
    });

    this.commands.set("status", {
      name: "status",
      description: "Check the current Claude Code session status",
      handler: async (interaction) => {
        await interaction.deferReply();
        this.emit("command:status", interaction);
      },
    });

    this.commands.set("output", {
      name: "output",
      description: "Show recent Claude Code output",
      options: [
        {
          name: "lines",
          description: "Number of lines to show (default: 50)",
          type: "integer",
          required: false,
        },
      ],
      handler: async (interaction) => {
        const lines = interaction.options.getInteger("lines") ?? 50;
        await interaction.deferReply();
        this.emit("command:output", lines, interaction);
      },
    });

    this.commands.set("resume", {
      name: "resume",
      description: "Resume the previous Claude Code session",
      handler: async (interaction) => {
        await interaction.deferReply();
        this.emit("command:resume", interaction);
      },
    });

    this.commands.set("abort", {
      name: "abort",
      description: "Abort the current Claude Code operation",
      handler: async (interaction) => {
        await interaction.deferReply();
        this.emit("command:abort", interaction);
      },
    });

    this.commands.set("send", {
      name: "send",
      description: "Send raw input to the Claude Code session",
      options: [
        {
          name: "input",
          description: "The input to send",
          type: "string",
          required: true,
        },
      ],
      handler: async (interaction) => {
        const input = interaction.options.getString("input", true);
        await interaction.deferReply();
        this.emit("command:send", input, interaction);
      },
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    // Verify owner
    if (interaction.user.id !== config.discord.ownerId) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "⛔ You are not authorized to use this bot.",
          ephemeral: true,
        });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = this.commands.get(interaction.commandName);
      if (command) {
        try {
          await command.handler(interaction);
        } catch (error) {
          logger.error({ error, command: interaction.commandName }, "Command error");
          const content = "❌ An error occurred while executing the command.";
          if (interaction.deferred) {
            await interaction.editReply({ content });
          } else {
            await interaction.reply({ content, ephemeral: true });
          }
        }
      }
    } else if (interaction.isButton()) {
      this.emit("button", interaction);
    } else if (interaction.isStringSelectMenu()) {
      this.emit("selectMenu", interaction);
    }
  }

  async connect(): Promise<void> {
    await this.client.login(config.discord.botToken);

    // Set up channel if specified
    if (config.discord.channelId) {
      const channel = await this.client.channels.fetch(config.discord.channelId);
      if (channel?.isTextBased()) {
        this.channel = channel as TextChannel;
      }
    }
  }

  async registerCommands(): Promise<void> {
    const commandData = Array.from(this.commands.values()).map((cmd) => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.name)
        .setDescription(cmd.description);

      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.type === "string") {
            builder.addStringOption((o) =>
              o.setName(opt.name)
                .setDescription(opt.description)
                .setRequired(opt.required ?? false)
            );
          } else if (opt.type === "integer") {
            builder.addIntegerOption((o) =>
              o.setName(opt.name)
                .setDescription(opt.description)
                .setRequired(opt.required ?? false)
            );
          } else if (opt.type === "boolean") {
            builder.addBooleanOption((o) =>
              o.setName(opt.name)
                .setDescription(opt.description)
                .setRequired(opt.required ?? false)
            );
          }
        }
      }

      return builder.toJSON();
    });

    try {
      await this.rest.put(
        Routes.applicationCommands(this.client.user!.id),
        { body: commandData }
      );
      logger.info({ count: commandData.length }, "Registered slash commands");
    } catch (error) {
      throw new DiscordError("Failed to register commands", error);
    }
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<ApprovalAction> {
    const embed = new EmbedBuilder()
      .setTitle("🔧 ツール実行の承認")
      .setColor(0xf59e0b)
      .addFields(
        { name: "ツール", value: `\`${request.toolName}\``, inline: true },
        { name: "ID", value: `\`${request.id}\``, inline: true }
      )
      .setTimestamp(request.timestamp);

    if (request.description) {
      embed.setDescription(request.description);
    }

    if (request.details) {
      // Truncate if too long
      const details = request.details.length > 1000
        ? request.details.slice(0, 997) + "..."
        : request.details;
      embed.addFields({ name: "詳細", value: `\`\`\`\n${details}\n\`\`\`` });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Approve}:${request.id}`)
        .setLabel("許可")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Reject}:${request.id}`)
        .setLabel("拒否")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.ApproveAll}:${request.id}`)
        .setLabel("全て許可")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋"),
      new ButtonBuilder()
        .setCustomId(`${ApprovalAction.Abort}:${request.id}`)
        .setLabel("中断")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🛑")
    );

    const message = await this.sendMessage({ embeds: [embed], components: [row] });

    return new Promise((resolve) => {
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: config.polling.approvalTimeoutMs,
        filter: (i) => i.user.id === config.discord.ownerId,
      });

      collector.on("collect", async (interaction) => {
        const [action] = interaction.customId.split(":") as [ApprovalAction, string];

        await interaction.update({
          components: [],
          embeds: [
            embed.setColor(
              action === ApprovalAction.Approve || action === ApprovalAction.ApproveAll
                ? 0x22c55e
                : 0xef4444
            ).addFields({
              name: "結果",
              value: this.getActionLabel(action),
            }),
          ],
        });

        collector.stop();
        resolve(action);
      });

      collector.on("end", (_collected, reason) => {
        if (reason === "time") {
          message.edit({
            components: [],
            embeds: [
              embed.setColor(0x6b7280).addFields({
                name: "結果",
                value: "⏰ タイムアウト（自動拒否）",
              }),
            ],
          });
          resolve(ApprovalAction.Reject);
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

  async sendMessage(options: Parameters<TextChannel["send"]>[0]): Promise<Message> {
    if (!this.channel) {
      throw new DiscordError("No channel configured");
    }
    return this.channel.send(options);
  }

  async sendOutput(content: string, title = "Claude Code 出力"): Promise<void> {
    const chunks = this.splitMessage(content, 1900);

    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setTitle(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title)
        .setDescription(`\`\`\`\n${chunks[i]}\n\`\`\``)
        .setColor(0x3b82f6)
        .setTimestamp();

      await this.sendMessage({ embeds: [embed] });
    }
  }

  async sendNotification(message: string, type: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
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
      .setDescription(`${icons[type]} ${message}`)
      .setColor(colors[type])
      .setTimestamp();

    await this.sendMessage({ embeds: [embed] });
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

  async disconnect(): Promise<void> {
    this.client.destroy();
    logger.info("Discord bot disconnected");
  }
}
