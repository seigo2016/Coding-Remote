import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createChildLogger } from "./logger.js";
import { getProjectMode } from "./project-mode.js";

const logger = createChildLogger("mode");

export type ApprovalMode = "discord" | "vscode" | "auto";

const MODE_FILE = join(homedir(), ".claude-approval-mode");

/**
 * Get effective approval mode for a project
 * Priority: project-specific > global > default
 */
export function getEffectiveMode(projectPath?: string): ApprovalMode {
  // Check project-specific mode first
  if (projectPath) {
    const projectMode = getProjectMode(projectPath);
    if (projectMode) {
      logger.debug({ projectPath, mode: projectMode }, "Using project-specific mode");
      return projectMode;
    }
  }
  // Fall back to global mode
  return getApprovalMode();
}

export function getApprovalMode(): ApprovalMode {
  try {
    if (existsSync(MODE_FILE)) {
      const content = readFileSync(MODE_FILE, "utf-8").trim();
      if (["discord", "vscode", "auto"].includes(content)) {
        return content as ApprovalMode;
      }
    }
  } catch (error) {
    logger.warn({ error }, "Failed to read mode file");
  }
  return "discord";
}

export function setApprovalMode(mode: ApprovalMode): void {
  try {
    writeFileSync(MODE_FILE, mode, "utf-8");
    logger.info({ mode }, "Approval mode set");
  } catch (error) {
    logger.error({ error }, "Failed to write mode file");
    throw error;
  }
}

export function getModeDescription(mode: ApprovalMode): string {
  switch (mode) {
    case "discord":
      return "🔔 Discord承認 - ツール実行前にDiscordで承認が必要";
    case "vscode":
      return "🖥️ VSCode UI - VSCodeのネイティブダイアログで承認";
    case "auto":
      return "⚡ 自動承認 - すべてのツールを自動承認（注意）";
  }
}

export function getModeFilePath(): string {
  return MODE_FILE;
}
