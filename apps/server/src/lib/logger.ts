import pino, { type Logger as PinoLogger } from 'pino';
import type { AppConfig } from '../config/index.js';

/**
 * Structured logging with a hard redaction policy: tokens, passwords, cookies,
 * private keys and message bodies must never reach the log stream.
 */

export type Logger = PinoLogger;

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-realtime-ticket"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'newPassword',
  'currentPassword',
  'refreshToken',
  'accessToken',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'twoFactorSecret',
  'ciphertext',
  '*.ciphertext',
  'identityKeyPublic',
  'signedPrekeyPublic',
  'message.body',
  '*.body',
  'err.config.headers.Authorization',
];

export function createLogger(cfg: AppConfig): Logger {
  const isTest = cfg.isTest;
  void isTest;
  return pino({
    level: cfg.LOG_LEVEL,
    base: { app: cfg.APP_NAME, profile: cfg.profile },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      cfg.isProduction || isTest
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app,profile' },
          },
  });
}

/** Creates a child logger bound to a request id / user id for traceability. */
export function requestLogger(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
