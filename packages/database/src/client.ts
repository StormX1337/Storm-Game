import { PrismaClient, Prisma } from '@prisma/client';

export type { Prisma };
export * from '@prisma/client';

export interface PrismaFactoryOptions {
  databaseUrl: string;
  logQueries?: boolean;
}

/**
 * Creates a configured Prisma client. Query logging is opt-in because the log
 * stream contains parameter values.
 */
export function createPrismaClient(options: PrismaFactoryOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [{ emit: 'stdout', level: 'error' }],
  });
}

/** Narrow a caught error to a Prisma known-request error with a given code. */
export function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

export const PRISMA_ERRORS = {
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
} as const;

/** BigInt columns are convenient in Postgres and hostile to JSON. */
export function bigIntToNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
