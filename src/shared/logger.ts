import pino from "pino";
import { config } from "./config";

/**
 * One logger, so every line lands in Cloud Logging as structured JSON rather
 * than as prose somebody has to grep with a regex.
 */
export const logger = pino({ level: config.LOG_LEVEL });
