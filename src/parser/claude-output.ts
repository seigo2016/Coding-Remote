import type { ClaudeState, ParsedOutput, ApprovalInfo } from "./types.js";

/**
 * Patterns to detect Claude Code state from terminal output
 */
const PATTERNS = {
  // Thinking/processing indicators
  thinking: [
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner
    /Thinking\.\.\./i,
    /Processing\.\.\./i,
  ],

  // Awaiting approval patterns
  awaitingApproval: [
    /Do you want to proceed\?/i,
    /Allow this action\?/i,
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /Press Enter to continue/i,
    /Approve\?/i,
    /Allow .+ to/i,
  ],

  // Tool execution patterns
  toolExecution: [
    /Running: (.+)/,
    /Executing: (.+)/,
    /Edit: (.+)/,
    /Write: (.+)/,
    /Read: (.+)/,
    /Bash: (.+)/,
  ],

  // Completion patterns
  completed: [
    /Task completed/i,
    /Done\./i,
    /Finished\./i,
    />\s*$/,  // Prompt returned
  ],

  // Error patterns
  error: [
    /Error:/i,
    /Failed:/i,
    /Exception:/i,
    /Permission denied/i,
  ],

  // Input request patterns
  awaitingInput: [
    /Enter .+:/i,
    /Input:/i,
    /\?\s*$/,
    />\s*$/,
  ],
};

/**
 * Tool name extraction patterns
 */
const TOOL_PATTERNS: Record<string, RegExp> = {
  Edit: /(?:Edit|Editing|Update|Modify)(?:ing)?\s*(?:file)?:?\s*[`"]?([^`"\n]+)[`"]?/i,
  Write: /(?:Write|Writing|Create|Creating)(?:ing)?\s*(?:file)?:?\s*[`"]?([^`"\n]+)[`"]?/i,
  Read: /(?:Read|Reading)(?:ing)?\s*(?:file)?:?\s*[`"]?([^`"\n]+)[`"]?/i,
  Bash: /(?:Run|Running|Execute|Executing|Bash):?\s*[`"]?(.+?)[`"]?$/im,
  Delete: /(?:Delete|Deleting|Remove|Removing):?\s*[`"]?([^`"\n]+)[`"]?/i,
};

export class ClaudeOutputParser {
  private previousState: ClaudeState = "idle";

  /**
   * Parse Claude Code terminal output and determine state
   */
  parse(output: string): ParsedOutput {
    const lines = output.split("\n");
    const lastLines = lines.slice(-50).join("\n"); // Focus on recent output

    // Check for error state first
    if (this.matchesAny(lastLines, PATTERNS.error)) {
      return {
        state: "error",
        content: output,
        error: this.extractError(lastLines),
      };
    }

    // Check for approval request
    if (this.matchesAny(lastLines, PATTERNS.awaitingApproval)) {
      const approval = this.extractApprovalInfo(output);
      return {
        state: "awaiting_approval",
        content: output,
        approval,
      };
    }

    // Check for thinking/processing
    if (this.matchesAny(lastLines, PATTERNS.thinking)) {
      return {
        state: "thinking",
        content: output,
      };
    }

    // Check for tool execution
    if (this.matchesAny(lastLines, PATTERNS.toolExecution)) {
      return {
        state: "executing",
        content: output,
      };
    }

    // Check for completion
    if (this.matchesAny(lastLines, PATTERNS.completed)) {
      return {
        state: "completed",
        content: output,
      };
    }

    // Check for input request
    if (this.matchesAny(lastLines, PATTERNS.awaitingInput)) {
      return {
        state: "awaiting_input",
        content: output,
      };
    }

    // Default to previous state or idle
    return {
      state: this.previousState,
      content: output,
    };
  }

  /**
   * Extract approval information from output
   */
  private extractApprovalInfo(output: string): ApprovalInfo {
    const lines = output.split("\n");

    // Try to find tool name and details
    for (const [toolName, pattern] of Object.entries(TOOL_PATTERNS)) {
      const match = output.match(pattern);
      if (match) {
        const info: ApprovalInfo = {
          toolName,
          description: match[0] ?? "",
        };

        if (toolName === "Edit" || toolName === "Write") {
          info.filePath = match[1];
          info.diff = this.extractDiff(output);
        } else if (toolName === "Bash") {
          info.command = match[1];
        }

        return info;
      }
    }

    // Fallback: extract last meaningful lines
    const meaningfulLines = lines
      .filter((l) => l.trim() && !l.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+$/))
      .slice(-10);

    return {
      toolName: "Unknown",
      description: meaningfulLines.join("\n"),
    };
  }

  /**
   * Extract diff content from output
   */
  private extractDiff(output: string): string | undefined {
    // Look for diff markers
    const diffPatterns = [
      /```diff\n([\s\S]*?)```/,
      /((?:^[-+].*\n?)+)/m,
      /(@@ .+ @@[\s\S]*?)(?=\n\n|\n[^-+@\s]|$)/,
    ];

    for (const pattern of diffPatterns) {
      const match = output.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  /**
   * Extract error message from output
   */
  private extractError(output: string): string {
    const errorPatterns = [
      /Error: (.+)/i,
      /Failed: (.+)/i,
      /Exception: (.+)/i,
    ];

    for (const pattern of errorPatterns) {
      const match = output.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return "Unknown error";
  }

  /**
   * Check if text matches any of the patterns
   */
  private matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }

  /**
   * Update and return previous state
   */
  updateState(state: ClaudeState): void {
    this.previousState = state;
  }

  /**
   * Reset parser state
   */
  reset(): void {
    this.previousState = "idle";
  }
}
