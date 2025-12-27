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

export class ApiError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "API_ERROR", cause);
    this.name = "ApiError";
  }
}

export class DiscordError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "DISCORD_ERROR", cause);
    this.name = "DiscordError";
  }
}
