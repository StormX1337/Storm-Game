// Runs the Prisma CLI with the workspace's root .env loaded (values already in
// the environment win). Resolves the CLI through Node's module resolution, so
// it works with any node_modules layout and inside the Docker images.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const rootEnv = path.resolve(packageDir, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const cli = createRequire(path.join(packageDir, 'package.json')).resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: packageDir,
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
