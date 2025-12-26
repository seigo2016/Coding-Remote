import type { DiffHunk } from "./types.js";

/**
 * Format diff for Discord display
 */
export function formatDiffForDiscord(diff: string, maxLines = 20): string {
  const lines = diff.split("\n");

  if (lines.length <= maxLines) {
    return diff;
  }

  // Truncate and add indicator
  const truncated = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  return `${truncated.join("\n")}\n... (${remaining} more lines)`;
}

/**
 * Parse unified diff format
 */
export function parseDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split("\n");

  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentHunk = {
        oldStart: parseInt(hunkMatch[1] ?? "0", 10),
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3] ?? "0", 10),
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Generate a compact diff summary
 */
export function summarizeDiff(diff: string): string {
  const hunks = parseDiff(diff);

  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      if (line.type === "remove") deletions++;
    }
  }

  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);

  return parts.join(" ") || "no changes";
}

/**
 * Highlight diff with ANSI colors (for terminal)
 */
export function highlightDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return `\x1b[32m${line}\x1b[0m`; // Green
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        return `\x1b[31m${line}\x1b[0m`; // Red
      } else if (line.startsWith("@@")) {
        return `\x1b[36m${line}\x1b[0m`; // Cyan
      }
      return line;
    })
    .join("\n");
}
