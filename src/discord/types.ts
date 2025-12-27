export enum ApprovalAction {
  Approve = "approve",
  Reject = "reject",
  ApproveAll = "approve_all",
  Abort = "abort",
}

export interface ToolApprovalRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  timestamp: Date;
}
