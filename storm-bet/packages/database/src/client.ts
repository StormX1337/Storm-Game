import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Anything that can run a query: the client itself or an open transaction. */
export type DbOrTx = PrismaClient | Prisma.TransactionClient;

export interface CreateClientOptions {
  url?: string;
  logQueries?: boolean;
}

export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    // Query errors surface as exceptions and are logged by the service that
    // handles them; Prisma's own error printing would only duplicate them.
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn'],
  });
}

/**
 * Runs `fn` in a SERIALIZABLE-free READ COMMITTED transaction with explicit
 * row locks (callers take them). A generous timeout covers lock waits behind
 * a concurrent odds update; the statement timeout stops a stuck query from
 * holding locks indefinitely.
 */
export async function withTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = 10000`;
      return fn(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: options.timeoutMs ?? 15_000,
    },
  );
}

/** True for Postgres/Prisma errors raised by a unique constraint. */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === 'P2002';
  return pgCode(error) === '23505';
}

/** SQLSTATE of a raw-query failure, if Prisma surfaced one. */
export function pgCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: unknown } | undefined;
    if (typeof meta?.code === 'string') return meta.code;
    const match = /Code: `(\w{5})`/.exec(error.message) ?? /SQLSTATE (\w{5})/.exec(error.message);
    return match?.[1] ?? null;
  }
  return null;
}
