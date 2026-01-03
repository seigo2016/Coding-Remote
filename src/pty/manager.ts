import * as pty from "node-pty";
import { EventEmitter } from "events";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createChildLogger } from "../utils/logger.js";
import type { PtyStatus, PtySession, ClaudeSession } from "./types.js";

const logger = createChildLogger("pty");

const MAX_OUTPUT_BUFFER = 100000; // 100KB

export class PtyManager extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private session: PtySession;
  private outputBuffer: string = "";
  private defaultWorkingDir: string;

  constructor(workingDir: string) {
    super();
    this.defaultWorkingDir = workingDir;
    this.session = {
      status: "idle",
      workingDir,
      outputBuffer: "",
    };
  }

  get status(): PtyStatus {
    return this.session.status;
  }

  get isRunning(): boolean {
    return this.session.status === "running";
  }

  get currentWorkingDir(): string {
    return this.session.workingDir;
  }

  /**
   * Encode project path to Claude's directory name format
   * e.g., "/home/seigo/work/project" -> "-home-seigo-work-project"
   */
  private encodeProjectPath(path: string): string {
    return path.replace(/\//g, "-");
  }

  /**
   * List available Claude Code sessions
   * @param filterProjectPath - Optional project path to filter sessions
   */
  async listSessions(filterProjectPath?: string): Promise<ClaudeSession[]> {
    const claudeDir = join(homedir(), ".claude", "projects");
    const sessions: ClaudeSession[] = [];
    // Encode filter path to match Claude's directory naming convention
    const encodedFilter = filterProjectPath
      ? this.encodeProjectPath(filterProjectPath.replace(/\/+$/, "")).toLowerCase()
      : undefined;

    try {
      const projectDirs = await readdir(claudeDir);

      for (const projectDir of projectDirs) {
        const projectPath = join(claudeDir, projectDir);
        const projectStat = await stat(projectPath);

        if (!projectStat.isDirectory()) continue;

        try {
          const sessionFiles = await readdir(projectPath);
          // Look for .jsonl files (JSON Lines format), excluding agent-* files
          const jsonlFiles = sessionFiles.filter(
            (f) => f.endsWith(".jsonl") && !f.startsWith("agent-")
          );

          for (const jsonlFile of jsonlFiles) {
            const sessionPath = join(projectPath, jsonlFile);
            const sessionStat = await stat(sessionPath);
            const sessionId = jsonlFile.replace(".jsonl", "");

            // Skip empty files
            if (sessionStat.size === 0) continue;

            let summary: string | undefined;
            try {
              const content = await readFile(sessionPath, "utf-8");
              const lines = content.trim().split("\n");
              // Find first user message in JSONL
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (entry.type === "user" && entry.message?.content) {
                    const textContent = entry.message.content.find(
                      (c: { type: string; text?: string }) => c.type === "text" && c.text
                    );
                    if (textContent?.text) {
                      // Skip IDE context messages
                      if (!textContent.text.startsWith("<ide_")) {
                        summary = textContent.text.slice(0, 100);
                        break;
                      }
                    }
                  }
                } catch {
                  // Skip malformed lines
                }
              }
            } catch {
              // Ignore parse errors
            }

            // Filter by project path if specified (compare encoded paths)
            if (encodedFilter) {
              if (projectDir.toLowerCase() !== encodedFilter) {
                continue;
              }
            }

            // Decode project path for display
            // "-home-seigo-work-project" -> "/home/seigo/work/project"
            // Note: This is lossy for paths containing hyphens (e.g., Coding-Remote)
            const decodedProjectPath = projectDir.replace(/^-/, "/").replace(/-/g, "/");

            sessions.push({
              id: sessionId,
              projectPath: decodedProjectPath,
              lastModified: sessionStat.mtime,
              summary,
            });
          }
        } catch {
          // Ignore unreadable directories
        }
      }

      // Sort by last modified, newest first
      sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

      return sessions;
    } catch (error) {
      logger.error({ error }, "Failed to list sessions");
      return [];
    }
  }

  /**
   * Start Claude Code CLI with --continue or --resume flag
   * @param sessionId - Optional session ID to resume
   * @param workingDir - Optional working directory (defaults to constructor value)
   */
  async startSession(sessionId?: string, workingDir?: string): Promise<void> {
    if (this.ptyProcess) {
      logger.warn("Session already running");
      return;
    }

    // Update working directory if provided
    const cwd = workingDir ?? this.defaultWorkingDir;
    this.session.workingDir = cwd;

    const args = sessionId ? ["--resume", sessionId] : ["--continue"];

    logger.info({ cwd, sessionId }, "Starting Claude Code session");

    this.ptyProcess = pty.spawn("claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: process.env as Record<string, string>,
    });

    this.session.status = "running";
    this.session.startedAt = new Date();
    this.session.sessionId = sessionId;
    this.outputBuffer = "";

    this.ptyProcess.onData((data) => {
      this.handleOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info({ exitCode, signal }, "Claude Code session exited");
      this.session.status = "stopped";
      this.ptyProcess = null;
      this.emit("exit", exitCode, signal);
    });

    this.emit("start");
  }

  /**
   * Send input to the PTY
   */
  write(data: string): void {
    if (!this.ptyProcess) {
      logger.warn("No active session to write to");
      return;
    }
    this.ptyProcess.write(data);
  }

  /**
   * Send a line of input (with Enter)
   */
  writeLine(data: string): void {
    this.write(data + "\r");
  }

  /**
   * Send Ctrl+C to interrupt
   */
  interrupt(): void {
    this.write("\x03");
  }

  /**
   * Stop the PTY session
   */
  async stopSession(): Promise<void> {
    if (!this.ptyProcess) {
      return;
    }

    logger.info("Stopping Claude Code session");

    // Try graceful exit first
    this.interrupt();

    // Wait a bit then force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.ptyProcess) {
          this.ptyProcess.kill();
        }
        resolve();
      }, 3000);

      if (this.ptyProcess) {
        const onExit = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.once("exit", onExit);
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.ptyProcess = null;
    this.session.status = "stopped";
  }

  /**
   * Get recent output
   */
  getOutput(lines?: number): string {
    if (!lines) {
      return this.outputBuffer;
    }

    const allLines = this.outputBuffer.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  /**
   * Clear output buffer
   */
  clearOutput(): void {
    this.outputBuffer = "";
  }

  /**
   * Handle output from PTY
   */
  private handleOutput(data: string): void {
    this.outputBuffer += data;

    // Trim buffer if too large
    if (this.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      this.outputBuffer = this.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    this.emit("output", data);
  }

  /**
   * Get session info
   */
  getSessionInfo(): PtySession {
    return {
      ...this.session,
      outputBuffer: this.outputBuffer,
    };
  }
}
