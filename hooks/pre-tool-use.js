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

async function main() {
  // Read input from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());

  const { tool_name, tool_input } = input;

  // Skip approval for read-only tools
  const readOnlyTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
  if (readOnlyTools.includes(tool_name)) {
    console.log(JSON.stringify({ decision: "approve" }));
    return;
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: tool_name,
        input: tool_input,
      }),
    });

    if (!response.ok) {
      // On error, default to approve (don't block)
      console.error(`API error: ${response.status}`);
      console.log(JSON.stringify({ decision: "approve" }));
      return;
    }

    const result = await response.json();

    if (result.action === "abort") {
      // Abort the entire operation
      console.log(JSON.stringify({ decision: "reject", reason: "Operation aborted by user" }));
      return;
    }

    console.log(
      JSON.stringify({
        decision: result.approved ? "approve" : "reject",
        reason: result.approved ? undefined : "Rejected by user",
      })
    );
  } catch (error) {
    // On network error, default to approve (bot might be offline)
    console.error(`Network error: ${error.message}`);
    console.log(JSON.stringify({ decision: "approve" }));
  }
}

main();
