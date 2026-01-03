import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { createChildLogger } from "../utils/logger.js";
import type { PtyStatus, PtySession, ClaudeSession, StreamMessage } from "./types.js";

const execAsync = promisify(exec);

const logger = createChildLogger("pty");

const MAX_OUTPUT_BUFFER = 100000; // 100KB

export class PtyManager extends EventEmitter {
  private claudeProcess: ChildProcess | null = null;
  private session: PtySession;
  private outputBuffer: string = "";
  private defaultWorkingDir: string;
  private messageBuffer: string = "";

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
   * Initialize a session for sending prompts
   * This doesn't start a process immediately - processes are spawned per-prompt
   * @param sessionId - Optional session ID to resume
   * @param workingDir - Optional working directory (defaults to constructor value)
   */
  async startSession(sessionId?: string, workingDir?: string): Promise<void> {
    if (this.session.status === "running") {
      logger.warn("Session already initialized");
      return;
    }

    // Update working directory if provided
    const cwd = workingDir ?? this.defaultWorkingDir;
    this.session.workingDir = cwd;
    this.session.status = "running";
    this.session.startedAt = new Date();
    this.session.sessionId = sessionId;
    this.outputBuffer = "";
    this.messageBuffer = "";

    logger.info({ cwd, sessionId }, "Session initialized (Stream-JSON mode, per-prompt spawning)");

    this.emit("start");
  }

  /**
   * Handle Stream-JSON output from Claude
   */
  private handleStreamOutput(data: string): void {
    this.messageBuffer += data;

    // Process complete lines
    const lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message: StreamMessage = JSON.parse(line);
        this.processStreamMessage(message);
      } catch {
        // Not JSON, treat as raw output
        logger.debug({ line }, "Non-JSON output");
        this.outputBuffer += line + "\n";
      }
    }

    this.emit("output", data);
  }

  /**
   * Process a parsed Stream-JSON message
   */
  private processStreamMessage(message: StreamMessage): void {
    const { type, subtype } = message;

    switch (type) {
      case "system":
        if (subtype === "init") {
          logger.info({ sessionId: message.session_id }, "Claude session initialized");
          if (message.session_id) {
            this.session.sessionId = message.session_id;
          }
        }
        break;

      case "assistant":
        if (message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === "text" && content.text) {
              this.outputBuffer += content.text + "\n";
              this.emit("assistant", content.text);
            } else if (content.type === "tool_use") {
              const toolInfo = `[Tool: ${content.name}]\n`;
              this.outputBuffer += toolInfo;
              this.emit("tool_use", content);
            }
          }
        }
        break;

      case "user":
        // Tool results come back as user messages
        if (message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === "tool_result") {
              this.outputBuffer += `[Tool Result]\n`;
            }
          }
        }
        break;

      case "result":
        if (message.result) {
          this.outputBuffer += `\n[Result] ${message.result}\n`;
          this.emit("result", message.result);
        }
        break;

      default:
        logger.debug({ message }, "Unknown stream message type");
    }

    // Trim buffer if too large
    if (this.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      this.outputBuffer = this.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }
  }

  /**
   * Send a prompt to Claude via Stream-JSON format
   * Since --print mode exits after each response, we spawn a new process for each prompt
   * but use --resume to continue the same session
   */
  async sendPrompt(prompt: string): Promise<void> {
    // If a process is already running, wait for it or reject
    if (this.claudeProcess) {
      logger.warn("A prompt is already being processed, please wait");
      return;
    }

    const cwd = this.session.workingDir;
    const sessionId = this.session.sessionId;

    // Build arguments for Stream-JSON mode
    const args = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    logger.info({ cwd, sessionId, prompt: prompt.slice(0, 100) }, "Sending prompt to Claude");

    this.claudeProcess = spawn("claude", args, {
      cwd,
      env: process.env as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.session.status = "running";
    this.messageBuffer = "";

    // Handle stdout (Stream-JSON messages)
    this.claudeProcess.stdout?.on("data", (data: Buffer) => {
      this.handleStreamOutput(data.toString());
    });

    // Handle stderr
    this.claudeProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      logger.debug({ stderr: text }, "Claude stderr");
      this.outputBuffer += `[stderr] ${text}`;
    });

    this.claudeProcess.on("exit", (exitCode, signal) => {
      logger.info({ exitCode, signal }, "Claude prompt completed");
      this.claudeProcess = null;
      // Keep status as "running" since session is still active (can send more prompts)
      // Only emit exit if it was an error
      if (exitCode !== 0) {
        this.emit("error", new Error(`Claude exited with code ${exitCode}`));
      }
    });

    this.claudeProcess.on("error", (error) => {
      logger.error({ error }, "Claude process error");
      this.claudeProcess = null;
      this.emit("error", error);
    });

    // Send the prompt
    const message = {
      type: "user",
      message: {
        role: "user",
        content: prompt,
      },
    };

    const jsonLine = JSON.stringify(message) + "\n";
    this.claudeProcess.stdin?.write(jsonLine);
    this.claudeProcess.stdin?.end(); // Close stdin to signal end of input
  }

  /**
   * Send raw input (legacy method for compatibility)
   */
  write(data: string): void {
    logger.warn("write() is deprecated for Stream-JSON mode, use sendPrompt()");
    this.sendPrompt(data);
  }

  /**
   * Send a line of input (legacy method for compatibility)
   */
  writeLine(data: string): void {
    this.sendPrompt(data);
  }

  /**
   * Interrupt the currently running prompt (sends SIGINT to process)
   */
  interrupt(): void {
    if (this.claudeProcess) {
      logger.info("Interrupting current prompt");
      this.claudeProcess.kill("SIGINT");
    }
  }

  /**
   * Stop the session (kills any running process and marks session as stopped)
   */
  async stopSession(): Promise<void> {
    logger.info("Stopping session");

    // Kill any running process
    if (this.claudeProcess) {
      this.claudeProcess.kill("SIGTERM");

      // Wait a bit then force kill
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.claudeProcess) {
            this.claudeProcess.kill("SIGKILL");
          }
          resolve();
        }, 3000);

        this.claudeProcess?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.claudeProcess = null;
    this.session.status = "stopped";
    this.emit("exit", 0, 0);
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
   * Get session info
   */
  getSessionInfo(): PtySession {
    return {
      ...this.session,
      outputBuffer: this.outputBuffer,
    };
  }

  /**
   * Find Claude processes using a specific session ID
   * Returns array of PIDs
   */
  async findClaudeProcesses(sessionId: string): Promise<number[]> {
    try {
      // Find Claude processes with --resume <sessionId>
      const { stdout } = await execAsync(
        `ps aux | grep -E 'claude.*--resume.*${sessionId}' | grep -v grep | awk '{print $2}'`
      );
      const pids = stdout
        .trim()
        .split("\n")
        .filter((pid) => pid)
        .map((pid) => parseInt(pid, 10))
        .filter((pid) => !isNaN(pid));

      logger.debug({ sessionId, pids }, "Found Claude processes");
      return pids;
    } catch {
      return [];
    }
  }

  /**
   * Kill Claude processes for a session (except our own process)
   * @returns Number of processes killed
   */
  async killClaudeProcesses(sessionId: string): Promise<number> {
    const pids = await this.findClaudeProcesses(sessionId);

    // Get our own process's PID to avoid killing it
    const ourPid = this.claudeProcess?.pid;
    const pidsToKill = pids.filter((pid) => pid !== ourPid);

    if (pidsToKill.length === 0) {
      logger.debug({ sessionId }, "No Claude processes to kill");
      return 0;
    }

    let killed = 0;
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGTERM");
        logger.info({ pid, sessionId }, "Killed Claude process");
        killed++;
      } catch (error) {
        logger.warn({ error, pid }, "Failed to kill process");
      }
    }

    return killed;
  }

  /**
   * Takeover a session from VSCode or other Claude processes
   * Kills existing processes and initializes session for prompts
   */
  async takeoverSession(sessionId: string, workingDir?: string): Promise<{ killed: number }> {
    logger.info({ sessionId, workingDir }, "Taking over session");

    // Kill any existing Claude processes using this session
    const killed = await this.killClaudeProcesses(sessionId);

    // Wait a bit for processes to terminate
    if (killed > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Initialize session (no process started yet, will spawn per-prompt)
    await this.startSession(sessionId, workingDir);

    return { killed };
  }
}
