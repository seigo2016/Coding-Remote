export type PtyStatus = "idle" | "running" | "stopped";

export interface PtySession {
  status: PtyStatus;
  startedAt?: Date;
  workingDir: string;
  outputBuffer: string;
}

export interface OutputChunk {
  content: string;
  timestamp: Date;
}
