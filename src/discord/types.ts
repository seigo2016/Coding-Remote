import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction
} from "discord.js";

export type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

export type ButtonHandler = (interaction: ButtonInteraction) => Promise<void>;

export type SelectMenuHandler = (interaction: StringSelectMenuInteraction) => Promise<void>;

export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
  handler: CommandHandler;
}

export interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required?: boolean;
  choices?: { name: string; value: string }[];
}

export enum ApprovalAction {
  Approve = "approve",
  Reject = "reject",
  ApproveAll = "approve_all",
  Abort = "abort",
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  description: string;
  details?: string;
  timestamp: Date;
}
