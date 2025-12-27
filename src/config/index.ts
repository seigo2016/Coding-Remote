import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  discord: z.object({
    botToken: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
    ownerId: z.string().min(1, "DISCORD_OWNER_ID is required"),
    channelId: z.string().min(1, "DISCORD_CHANNEL_ID is required"),
  }),
  api: z.object({
    port: z.number().int().positive().default(3456),
    host: z.string().default("127.0.0.1"),
  }),
  approval: z.object({
    timeoutMs: z.number().int().positive().default(300000), // 5 minutes
    defaultAction: z.enum(["approve", "reject"]).default("approve"),
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
      channelId: process.env["DISCORD_CHANNEL_ID"] ?? "",
    },
    api: {
      port: parseInt(process.env["API_PORT"] ?? "3456", 10),
      host: process.env["API_HOST"] ?? "127.0.0.1",
    },
    approval: {
      timeoutMs: parseInt(process.env["APPROVAL_TIMEOUT_MS"] ?? "300000", 10),
      defaultAction: process.env["APPROVAL_DEFAULT_ACTION"] ?? "approve",
    },
    log: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  };

  return configSchema.parse(rawConfig);
}

export const config = loadConfig();
