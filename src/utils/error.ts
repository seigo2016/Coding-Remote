export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class TmuxError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "TMUX_ERROR", cause);
    this.name = "TmuxError";
  }
}

export class DiscordError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "DISCORD_ERROR", cause);
    this.name = "DiscordError";
  }
}

export class ParserError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "PARSER_ERROR", cause);
    this.name = "ParserError";
  }
}
