import {
  ThreadChannel,
  ChannelType,
  type TextChannel,
} from "discord.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("thread-manager");

export interface ProjectThread {
  projectPath: string;
  projectName: string;
  thread: ThreadChannel;
  createdAt: Date;
  lastActivity: Date;
}

export class ThreadManager {
  private threads: Map<string, ProjectThread> = new Map();
  private parentChannel: TextChannel | null = null;

  setParentChannel(channel: TextChannel): void {
    this.parentChannel = channel;
    logger.info({ channelId: channel.id }, "Parent channel set");
  }

  /**
   * Get or create a thread for a project
   */
  async getOrCreateThread(projectPath: string): Promise<ThreadChannel> {
    if (!this.parentChannel) {
      throw new Error("Parent channel not set");
    }

    // Normalize project path
    const normalizedPath = this.normalizePath(projectPath);
    const projectName = this.getProjectName(normalizedPath);

    // Check if we already have this thread cached
    const cached = this.threads.get(normalizedPath);
    if (cached) {
      cached.lastActivity = new Date();
      return cached.thread;
    }

    // Try to find existing thread
    const existingThread = await this.findExistingThread(projectName);
    if (existingThread) {
      this.cacheThread(normalizedPath, projectName, existingThread);
      return existingThread;
    }

    // Create new thread
    const thread = await this.createThread(projectName, normalizedPath);
    this.cacheThread(normalizedPath, projectName, thread);
    return thread;
  }

  /**
   * Get thread for a project if it exists
   */
  getThread(projectPath: string): ThreadChannel | null {
    const normalizedPath = this.normalizePath(projectPath);
    return this.threads.get(normalizedPath)?.thread ?? null;
  }

  /**
   * Get project path from thread ID
   */
  getProjectPathFromThread(threadId: string): string | null {
    for (const [path, project] of this.threads) {
      if (project.thread.id === threadId) {
        return path;
      }
    }
    return null;
  }

  /**
   * List all active project threads
   */
  listThreads(): ProjectThread[] {
    return Array.from(this.threads.values()).sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
    );
  }

  /**
   * Archive a project thread
   */
  async archiveThread(projectPath: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(projectPath);
    const cached = this.threads.get(normalizedPath);

    if (cached) {
      try {
        await cached.thread.setArchived(true);
        this.threads.delete(normalizedPath);
        logger.info({ projectPath: normalizedPath }, "Thread archived");
        return true;
      } catch (error) {
        logger.error({ error, projectPath: normalizedPath }, "Failed to archive thread");
      }
    }
    return false;
  }

  private normalizePath(path: string): string {
    // Remove trailing slashes and normalize
    return path.replace(/\/+$/, "").toLowerCase();
  }

  private getProjectName(projectPath: string): string {
    // Extract project name from path (last component)
    const parts = projectPath.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown-project";
  }

  private async findExistingThread(projectName: string): Promise<ThreadChannel | null> {
    if (!this.parentChannel) return null;

    try {
      // Fetch active threads
      const threads = await this.parentChannel.threads.fetchActive();

      // Look for thread with matching name
      const threadName = this.formatThreadName(projectName);
      const found = threads.threads.find(
        (t) => t.name.toLowerCase() === threadName.toLowerCase()
      );

      if (found) {
        logger.info({ threadId: found.id, projectName }, "Found existing thread");
        return found;
      }

      // Also check archived threads
      const archived = await this.parentChannel.threads.fetchArchived({ limit: 100 });
      const archivedFound = archived.threads.find(
        (t) => t.name.toLowerCase() === threadName.toLowerCase()
      );

      if (archivedFound) {
        // Unarchive the thread
        await archivedFound.setArchived(false);
        logger.info({ threadId: archivedFound.id, projectName }, "Unarchived existing thread");
        return archivedFound;
      }
    } catch (error) {
      logger.warn({ error, projectName }, "Error finding existing thread");
    }

    return null;
  }

  private async createThread(projectName: string, projectPath: string): Promise<ThreadChannel> {
    if (!this.parentChannel) {
      throw new Error("Parent channel not set");
    }

    const threadName = this.formatThreadName(projectName);

    const thread = await this.parentChannel.threads.create({
      name: threadName,
      type: ChannelType.PublicThread,
      reason: `Claude Code project: ${projectPath}`,
    });

    // Send initial message
    await thread.send({
      embeds: [{
        title: `📁 ${projectName}`,
        description: `プロジェクト: \`${projectPath}\`\n\nこのスレッドでは、このプロジェクトに関する:\n- ツール実行の承認リクエスト\n- CLIセッションの操作\n- 出力の表示\n\nが行われます。`,
        color: 0x3b82f6,
        timestamp: new Date().toISOString(),
      }],
    });

    logger.info({ threadId: thread.id, projectName, projectPath }, "Created new thread");
    return thread;
  }

  private formatThreadName(projectName: string): string {
    // Format: 📁 project-name
    return `📁 ${projectName}`;
  }

  private cacheThread(projectPath: string, projectName: string, thread: ThreadChannel): void {
    this.threads.set(projectPath, {
      projectPath,
      projectName,
      thread,
      createdAt: new Date(),
      lastActivity: new Date(),
    });
  }

  /**
   * Clean up old inactive threads (optional maintenance)
   */
  async cleanupInactiveThreads(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [path, project] of this.threads) {
      if (now - project.lastActivity.getTime() > maxAgeMs) {
        await this.archiveThread(path);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, "Cleaned up inactive threads");
    }

    return cleaned;
  }
}
