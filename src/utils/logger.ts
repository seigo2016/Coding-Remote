import pino from "pino";
import { config } from "../config/index.js";

const pinoLogger = pino.default ?? pino;

export const logger = pinoLogger({
  level: config.log.level,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
