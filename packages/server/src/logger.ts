import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    // Job step bodies and definitions can contain connection strings (§6.6);
    // keep them out of logs entirely rather than relying on redaction.
    redact: {
      paths: ['*.canonicalJson', '*.command', '*.password', 'req.headers.cookie'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
