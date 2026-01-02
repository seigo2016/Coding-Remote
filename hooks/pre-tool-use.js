#!/usr/bin/env node

/**
 * Claude Code PreToolUse Hook
 *
 * This script is called by Claude Code before executing a tool.
 * It sends an approval request to the approval server and waits for a response.
 *
 * Input (stdin): JSON with tool_name and tool_input
 * Output (stdout): JSON with "decision" field
 *
 * Environment variables:
 *   APPROVAL_API_URL - API endpoint (default: http://127.0.0.1:3456/approval)
 *   APPROVAL_TIMEOUT_SECS - Timeout in seconds (default: 300, max 600)
 *
 * Setup:
 *   Add to ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "*",
 *         "command": "node /path/to/hooks/pre-tool-use.js"
 *       }]
 *     }
 *   }
 */

const API_URL = process.env.APPROVAL_API_URL || "http://127.0.0.1:3456/approval";
const TIMEOUT_SECS = Math.min(600, parseInt(process.env.APPROVAL_TIMEOUT_SECS || "300", 10));

function log(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] pre-tool-use: ${message}`);
}

async function main() {
  // Read input from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());

  const { tool_name, tool_input } = input;

  log(`Tool: ${tool_name}`);

  // Skip approval for read-only tools
  const readOnlyTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoRead"];
  if (readOnlyTools.includes(tool_name)) {
    log(`Skipping approval for read-only tool: ${tool_name}`);
    console.log(JSON.stringify({ decision: "approve" }));
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
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!response.ok) {
      log(`API error: ${response.status} (${elapsed}s)`);
      console.log(JSON.stringify({ decision: "approve" }));
      return;
    }

    const result = await response.json();
    log(`Response received: action=${result.action}, approved=${result.approved} (${elapsed}s)`);

    if (result.action === "abort") {
      log("Operation aborted by user");
      console.log(JSON.stringify({ decision: "reject", reason: "Operation aborted by user" }));
      return;
    }

    const decision = result.approved ? "approve" : "reject";
    log(`Final decision: ${decision}`);
    console.log(
      JSON.stringify({
        decision,
        reason: result.approved ? undefined : "Rejected by user",
      })
    );
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      log(`Request timed out after ${TIMEOUT_SECS}s, defaulting to approve`);
    } else {
      log(`Network error: ${error.message}, defaulting to approve`);
    }
    console.log(JSON.stringify({ decision: "approve" }));
  }
}

main();
