import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Resets the test database to a clean schema and applies every migration once
 * per run. `migrate reset` drops the schema, which is the only way to clear
 * the append-only ledger tables — exactly as it should be.
 */
export default function setup(): void {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://stormbet:stormbet@localhost:5432/stormbet_test?schema=public';
  const cwd = fileURLToPath(new URL('../../packages/database', import.meta.url));
  execFileSync(
    process.execPath,
    [
      './node_modules/prisma/build/index.js',
      'migrate',
      'reset',
      '--force',
      '--skip-seed',
      '--skip-generate',
    ],
    { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
  );
}
