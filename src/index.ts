import { logger } from "./utils/logger.js";
import { DiscordBot } from "./discord/client.js";
import { TmuxManager } from "./tmux/manager.js";
import { SessionOrchestrator } from "./session/orchestrator.js";

async function main() {
  logger.info("Starting Claude Discord Bot...");

  const tmuxManager = new TmuxManager();
  const discordBot = new DiscordBot();
  const orchestrator = new SessionOrchestrator(tmuxManager, discordBot);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await orchestrator.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await orchestrator.start();
    logger.info("Claude Discord Bot is running");
  } catch (error) {
    logger.error({ error }, "Failed to start bot");
    process.exit(1);
  }
}

main();
