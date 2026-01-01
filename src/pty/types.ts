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
