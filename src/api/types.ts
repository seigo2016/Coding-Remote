export interface ApprovalRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  timestamp: Date;
}

export interface ApprovalResponse {
  approved: boolean;
  action: "approve" | "reject" | "approve_all" | "abort";
}

export type PendingApproval = {
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  timeoutId: NodeJS.Timeout;
};
