import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  discord: z.object({
    botToken: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
    ownerId: z.string().min(1, "DISCORD_OWNER_ID is required"),
    channelId: z.string().optional(),
  }),
  claude: z.object({
    workingDir: z.string().default(process.cwd()),
    tmuxSessionName: z.string().default("claude-code"),
  }),
  polling: z.object({
    intervalMs: z.number().int().positive().default(2000),
    approvalTimeoutMs: z.number().int().positive().default(300000), // 5 minutes
  }),
  log: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  }),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const rawConfig = {
    discord: {
      botToken: process.env["DISCORD_BOT_TOKEN"] ?? "",
      ownerId: process.env["DISCORD_OWNER_ID"] ?? "",
      channelId: process.env["DISCORD_CHANNEL_ID"],
    },
    claude: {
      workingDir: process.env["CLAUDE_WORKING_DIR"] ?? process.cwd(),
      tmuxSessionName: process.env["TMUX_SESSION_NAME"] ?? "claude-code",
    },
    polling: {
      intervalMs: parseInt(process.env["POLL_INTERVAL_MS"] ?? "2000", 10),
      approvalTimeoutMs: parseInt(process.env["APPROVAL_TIMEOUT_MS"] ?? "300000", 10),
    },
    log: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  };

  return configSchema.parse(rawConfig);
}

export const config = loadConfig();
