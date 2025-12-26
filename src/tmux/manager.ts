import { exec } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import { TmuxError } from "../utils/error.js";
import type { TmuxSession, TmuxCaptureOptions, SessionStatus } from "./types.js";

const execAsync = promisify(exec);

const logger = createChildLogger("tmux");

export class TmuxManager extends EventEmitter {
  private sessionName: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastOutput = "";

  constructor(sessionName?: string) {
    super();
    this.sessionName = sessionName ?? config.claude.tmuxSessionName;
  }

  /**
   * Check if tmux is available on the system
   */
  async checkTmuxAvailable(): Promise<boolean> {
    try {
      await execAsync("tmux -V");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(): Promise<SessionStatus> {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}:#{session_attached}" 2>/dev/null`
      );

      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const [name, attached] = line.split(":");
        if (name === this.sessionName) {
          return attached === "1" ? "attached" : "detached";
        }
      }
      return "not_found";
    } catch {
      return "not_found";
    }
  }

  /**
   * Create a new tmux session with Claude Code
   */
  async createSession(workingDir?: string): Promise<void> {
    const dir = workingDir ?? config.claude.workingDir;

    const status = await this.getSessionStatus();
    if (status !== "not_found") {
      logger.info({ session: this.sessionName }, "Session already exists");
      return;
    }

    try {
      await execAsync(
        `tmux new-session -d -s "${this.sessionName}" -c "${dir}"`
      );
      logger.info({ session: this.sessionName, dir }, "Created new tmux session");
    } catch (error) {
      throw new TmuxError(`Failed to create session: ${this.sessionName}`, error);
    }
  }

  /**
   * Start Claude Code in the session
   */
  async startClaudeCode(args: string[] = []): Promise<void> {
    const argsStr = args.join(" ");
    const command = `claude ${argsStr}`.trim();

    await this.sendKeys(command);
    await this.sendKeys("Enter", true);

    logger.info({ command }, "Started Claude Code");
  }

  /**
   * Resume previous Claude Code session
   */
  async resumeClaudeCode(): Promise<void> {
    await this.sendKeys("claude --continue");
    await this.sendKeys("Enter", true);

    logger.info("Resumed Claude Code session");
  }

  /**
   * Send keys to the tmux session
   */
  async sendKeys(keys: string, literal = false): Promise<void> {
    const status = await this.getSessionStatus();
    if (status === "not_found") {
      throw new TmuxError("Session not found");
    }

    try {
      const literalFlag = literal ? "-l" : "";
      const escapedKeys = keys.replace(/"/g, '\\"');
      await execAsync(
        `tmux send-keys -t "${this.sessionName}" ${literalFlag} "${escapedKeys}"`
      );
    } catch (error) {
      throw new TmuxError(`Failed to send keys to session`, error);
    }
  }

  /**
   * Capture current pane output
   */
  async capturePane(options: TmuxCaptureOptions = {}): Promise<string> {
    const status = await this.getSessionStatus();
    if (status === "not_found") {
      throw new TmuxError("Session not found");
    }

    const { start = -500, end = -1, escapeSequences = false } = options;
    const escapeFlag = escapeSequences ? "-e" : "";

    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${this.sessionName}" -p ${escapeFlag} -S ${start} -E ${end}`
      );
      return stdout;
    } catch (error) {
      throw new TmuxError("Failed to capture pane", error);
    }
  }

  /**
   * Start polling for output changes
   */
  startPolling(intervalMs?: number): void {
    if (this.pollInterval) {
      return;
    }

    const interval = intervalMs ?? config.polling.intervalMs;

    this.pollInterval = setInterval(async () => {
      try {
        const output = await this.capturePane();

        if (output !== this.lastOutput) {
          const newContent = this.extractNewContent(this.lastOutput, output);
          this.lastOutput = output;

          if (newContent) {
            this.emit("output", newContent, output);
          }
        }
      } catch (error) {
        logger.error({ error }, "Polling error");
        this.emit("error", error);
      }
    }, interval);

    logger.info({ interval }, "Started polling");
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info("Stopped polling");
    }
  }

  /**
   * Kill the tmux session
   */
  async killSession(): Promise<void> {
    try {
      await execAsync(`tmux kill-session -t "${this.sessionName}"`);
      logger.info({ session: this.sessionName }, "Killed session");
    } catch (error) {
      // Session might already be dead
      logger.debug({ error }, "Failed to kill session (might not exist)");
    }
  }

  /**
   * List all tmux sessions
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}" 2>/dev/null`
      );

      return stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [name, created, attached, windows] = line.split("|");
        return {
          name: name ?? "",
          created: new Date(parseInt(created ?? "0", 10) * 1000),
          attached: attached === "1",
          windows: parseInt(windows ?? "1", 10),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Extract new content from output diff
   */
  private extractNewContent(oldOutput: string, newOutput: string): string {
    const oldLines = oldOutput.split("\n");
    const newLines = newOutput.split("\n");

    // Find where they diverge
    let commonIndex = 0;
    while (
      commonIndex < oldLines.length &&
      commonIndex < newLines.length &&
      oldLines[commonIndex] === newLines[commonIndex]
    ) {
      commonIndex++;
    }

    return newLines.slice(commonIndex).join("\n");
  }

  get currentSessionName(): string {
    return this.sessionName;
  }
}
