import { logger } from "./utils/logger.js";
import { DiscordBot } from "./discord/client.js";
import { ApprovalServer } from "./api/server.js";
import { ApprovalAction } from "./discord/types.js";

async function main() {
  logger.info("Starting Claude Code Approval Bot...");

  const discord = new DiscordBot();
  const api = new ApprovalServer();

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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await api.stop();
    await discord.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await discord.connect();
    await api.start();
    await discord.sendNotification("🤖 Approval Bot is online", "success");
    logger.info("Claude Code Approval Bot is running");
  } catch (error) {
    logger.error({ error }, "Failed to start bot");
    process.exit(1);
  }
}

main();
