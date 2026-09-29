import pino, { type Logger } from 'pino';

export function createLogger(level: string, service: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { service },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  });
}
