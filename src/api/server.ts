import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import { config } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";
import type { ApprovalRequest, ApprovalResponse, PendingApproval } from "./types.js";

const logger = createChildLogger("api");

export class ApprovalServer {
  private server: ReturnType<typeof createServer> | null = null;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approveAllMode = false;
  private onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalResponse>;

  setApprovalHandler(handler: (request: ApprovalRequest) => Promise<ApprovalResponse>): void {
    this.onApprovalRequest = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(config.api.port, config.api.host, () => {
        logger.info({ port: config.api.port, host: config.api.host }, "API server started");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Clear all pending approvals
    for (const [id, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ approved: false, action: "abort" });
      this.pendingApprovals.delete(id);
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info("API server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST" || req.url !== "/approval") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      const data = JSON.parse(body);

      const request: ApprovalRequest = {
        id: randomUUID().slice(0, 8),
        tool: data.tool ?? "Unknown",
        input: data.input ?? {},
        timestamp: new Date(),
      };

      logger.info({ tool: request.tool, id: request.id }, "Received approval request");

      // If approve-all mode is active, auto-approve
      if (this.approveAllMode) {
        logger.info({ id: request.id }, "Auto-approved (approve-all mode)");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ approved: true, action: "approve_all" }));
        return;
      }

      // Request approval via Discord
      if (!this.onApprovalRequest) {
        throw new Error("No approval handler configured");
      }

      const response = await this.onApprovalRequest(request);

      // Handle approve-all
      if (response.action === "approve_all") {
        this.approveAllMode = true;
        logger.info("Approve-all mode activated");
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      logger.error({ error }, "Error handling approval request");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", approved: false }));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  resetApproveAllMode(): void {
    this.approveAllMode = false;
    logger.info("Approve-all mode reset");
  }
}
