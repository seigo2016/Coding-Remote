export type SessionState =
  | "idle"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "stopped"
  | "error";

export interface SessionInfo {
  id: string;
  state: SessionState;
  startedAt?: Date;
  workingDir: string;
  lastActivity?: Date;
  approvalMode: ApprovalMode;
}

export type ApprovalMode = "ask" | "auto_approve" | "auto_reject";

export interface SessionEvent {
  type: SessionEventType;
  timestamp: Date;
  data?: unknown;
}

export type SessionEventType =
  | "started"
  | "stopped"
  | "output"
  | "approval_requested"
  | "approval_resolved"
  | "error"
  | "state_changed";
