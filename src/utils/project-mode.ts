import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createChildLogger } from "./logger.js";
import type { ApprovalMode } from "./mode.js";

const logger = createChildLogger("project-mode");

const PROJECT_MODE_FILE = join(homedir(), ".claude-approval-modes.json");

interface ProjectModeData {
  modes: Record<string, ApprovalMode>;
  updatedAt: string;
}

/**
 * Load project modes from file
 */
function loadProjectModes(): Record<string, ApprovalMode> {
  try {
    if (existsSync(PROJECT_MODE_FILE)) {
      const content = readFileSync(PROJECT_MODE_FILE, "utf-8");
      const data: ProjectModeData = JSON.parse(content);
      return data.modes || {};
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load project modes");
  }
  return {};
}

/**
 * Save project modes to file
 */
function saveProjectModes(modes: Record<string, ApprovalMode>): void {
  try {
    const data: ProjectModeData = {
      modes,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(PROJECT_MODE_FILE, JSON.stringify(data, null, 2), "utf-8");
    logger.info({ count: Object.keys(modes).length }, "Project modes saved");
  } catch (error) {
    logger.error({ error }, "Failed to save project modes");
    throw error;
  }
}

/**
 * Normalize project path for consistent lookup
 */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, "").toLowerCase();
}

/**
 * Get approval mode for a specific project
 * Returns null if no project-specific mode is set
 */
export function getProjectMode(projectPath: string): ApprovalMode | null {
  const modes = loadProjectModes();
  const normalized = normalizePath(projectPath);
  return modes[normalized] ?? null;
}

/**
 * Set approval mode for a specific project
 */
export function setProjectMode(projectPath: string, mode: ApprovalMode): void {
  const modes = loadProjectModes();
  const normalized = normalizePath(projectPath);
  modes[normalized] = mode;
  saveProjectModes(modes);
  logger.info({ projectPath: normalized, mode }, "Project mode set");
}

/**
 * Remove project-specific mode (will fall back to global)
 */
export function clearProjectMode(projectPath: string): boolean {
  const modes = loadProjectModes();
  const normalized = normalizePath(projectPath);
  if (normalized in modes) {
    delete modes[normalized];
    saveProjectModes(modes);
    logger.info({ projectPath: normalized }, "Project mode cleared");
    return true;
  }
  return false;
}

/**
 * List all project-specific modes
 */
export function listProjectModes(): Record<string, ApprovalMode> {
  return loadProjectModes();
}

/**
 * Get the file path for project modes
 */
export function getProjectModeFilePath(): string {
  return PROJECT_MODE_FILE;
}
