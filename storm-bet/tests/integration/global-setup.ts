import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Applies pending migrations to the dedicated test database. Nothing is ever
 * reset or truncated: every suite creates its own users, events and bets with
 * unique identifiers, which is also the only thing the append-only ledger
 * tables allow.
 */
export default function setup(): void {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://stormbet:stormbet@localhost:5432/stormbet_test?schema=public';
  const cwd = fileURLToPath(new URL('../../packages/database', import.meta.url));
  execFileSync(process.execPath, ['scripts/prisma.mjs', 'migrate', 'deploy'], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
