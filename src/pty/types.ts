export type PtyStatus = "idle" | "running" | "stopped";

export interface PtySession {
  status: PtyStatus;
  startedAt?: Date;
  workingDir: string;
  outputBuffer: string;
  sessionId?: string;
}

export interface OutputChunk {
  content: string;
  timestamp: Date;
}

export interface ClaudeSession {
  id: string;
  projectPath: string;
  lastModified: Date;
  summary?: string;
}

/**
 * Stream-JSON message types from Claude CLI
 */
export interface StreamMessageContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface StreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  tools?: unknown[];
  message?: {
    role?: string;
    content?: StreamMessageContent[];
  };
  result?: string;
}
