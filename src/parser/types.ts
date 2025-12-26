export type ClaudeState =
  | "idle"
  | "thinking"
  | "executing"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "error";

export interface ParsedOutput {
  state: ClaudeState;
  content: string;
  approval?: ApprovalInfo;
  error?: string;
}

export interface ApprovalInfo {
  toolName: string;
  description: string;
  diff?: string;
  filePath?: string;
  command?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
}
