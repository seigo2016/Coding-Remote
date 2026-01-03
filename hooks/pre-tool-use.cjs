#!/usr/bin/env node

/**
 * Claude Code PreToolUse Hook
 *
 * This script is called by Claude Code before executing a tool.
 * It sends an approval request to the approval server and waits for a response.
 *
 * Input (stdin): JSON with tool_name and tool_input
 * Output (stdout): JSON with permissionDecision for Claude Code
 *
 * Mode is read from ~/.claude-approval-mode file (managed via Discord /mode command)
 * Modes: "discord" (default), "vscode" (native UI), "auto" (auto-approve all)
 *
 * Environment variables:
 *   APPROVAL_API_URL - API endpoint (default: http://127.0.0.1:3456/approval)
 *   APPROVAL_TIMEOUT_SECS - Timeout in seconds (default: 300, max 600)
 *
 * Setup (~/.claude/settings.json):
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "*",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node /path/to/hooks/pre-tool-use.cjs",
 *           "timeout": 300
 *         }]
 *       }]
 *     }
 *   }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const API_URL = process.env.APPROVAL_API_URL || "http://127.0.0.1:3456/approval";
const TIMEOUT_SECS = Math.min(600, parseInt(process.env.APPROVAL_TIMEOUT_SECS || "300", 10));
const MODE_FILE = path.join(os.homedir(), ".claude-approval-mode");
const PROJECT_MODE_FILE = path.join(os.homedir(), ".claude-approval-modes.json");

/**
 * Normalize project path for consistent lookup
 */
function normalizePath(p) {
  return p.replace(/\/+$/, "").toLowerCase();
}

/**
 * Read project-specific mode from JSON file
 */
function getProjectMode(projectPath) {
  try {
    if (fs.existsSync(PROJECT_MODE_FILE)) {
      const content = fs.readFileSync(PROJECT_MODE_FILE, "utf-8");
      const data = JSON.parse(content);
      const normalized = normalizePath(projectPath);
      const mode = data.modes?.[normalized];
      if (mode && ["discord", "vscode", "auto"].includes(mode)) {
        return mode;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Read global approval mode from file
 */
function getGlobalMode() {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const content = fs.readFileSync(MODE_FILE, "utf-8").trim();
      if (["discord", "vscode", "auto"].includes(content)) {
        return content;
      }
    }
  } catch {
    // Ignore errors
  }
  return "discord";
}

/**
 * Get effective mode for a project (project-specific > global > default)
 */
function getEffectiveMode(projectPath) {
  if (projectPath) {
    const projectMode = getProjectMode(projectPath);
    if (projectMode) {
      return projectMode;
    }
  }
  return getGlobalMode();
}

function log(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] pre-tool-use: ${message}`);
}

/**
 * Output response in Claude Code's expected format
 */
function outputResponse(decision, reason) {
  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision, // "allow", "deny", or "ask"
      permissionDecisionReason: reason || undefined,
    },
  };
  log(`Output: ${JSON.stringify(response)}`);
  console.log(JSON.stringify(response));
}

async function main() {
  // Read input from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());

  // Claude Code provides: tool_name, tool_input, cwd, session_id
  const { tool_name, tool_input, cwd, session_id } = input;

  const mode = getEffectiveMode(cwd);
  log(`Tool: ${tool_name}, Mode: ${mode}, CWD: ${cwd || "unknown"}`);

  // VSCode mode: let native UI handle approval
  if (mode === "vscode") {
    log("VSCode mode - delegating to native UI");
    // Return empty output to let Claude Code show its native dialog
    console.log("{}");
    return;
  }

  // Auto mode: approve everything automatically
  if (mode === "auto") {
    log("Auto mode - auto-approving");
    outputResponse("allow", "Auto-approved (auto mode)");
    return;
  }

  // Skip approval for read-only tools
  const readOnlyTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoRead"];
  if (readOnlyTools.includes(tool_name)) {
    log(`Skipping approval for read-only tool: ${tool_name}`);
    outputResponse("allow", "Read-only tool auto-approved");
    return;
  }

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    log(`Timeout after ${TIMEOUT_SECS}s, aborting request`);
    controller.abort();
  }, TIMEOUT_SECS * 1000);

  try {
    log(`Sending approval request to ${API_URL}`);
    const startTime = Date.now();

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: tool_name,
        input: tool_input,
        cwd: cwd || process.cwd(),
        sessionId: session_id,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!response.ok) {
      log(`API error: ${response.status} (${elapsed}s)`);
      outputResponse("allow", "API error - auto-approved");
      return;
    }

    const result = await response.json();
    log(`Response received: action=${result.action}, approved=${result.approved} (${elapsed}s)`);

    if (result.action === "abort") {
      log("Operation aborted by user");
      outputResponse("deny", "Operation aborted by user via Discord");
      process.exit(2); // Exit code 2 ensures denial
      return;
    }

    if (result.approved) {
      outputResponse("allow", "Approved via Discord");
    } else {
      outputResponse("deny", "Rejected by user via Discord");
      process.exit(2); // Exit code 2 ensures denial
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      log(`Request timed out after ${TIMEOUT_SECS}s, defaulting to allow`);
    } else {
      log(`Network error: ${error.message}, defaulting to allow`);
    }
    outputResponse("allow", "Network/timeout error - auto-approved");
  }
}

main();
