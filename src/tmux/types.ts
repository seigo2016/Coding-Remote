export interface TmuxSession {
  name: string;
  created: Date;
  attached: boolean;
  windows: number;
}

export interface TmuxCaptureOptions {
  start?: number;  // Start line (negative = from end)
  end?: number;    // End line
  escapeSequences?: boolean;  // Include escape sequences
}

export type SessionStatus =
  | "not_found"
  | "running"
  | "attached"
  | "detached";
