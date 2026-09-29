// Bundles a Node service (api, worker) into one ESM file.
//
// Workspace packages (@storm-bet/*) ship TypeScript source, so they are
// compiled into the bundle; third-party dependencies stay external and are
// resolved from node_modules at runtime (Prisma needs its generated client
// and engine on disk, argon2 its native binding).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: build-service.mjs <entry> <outfile>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // ESM output still meets CommonJS dependencies that call require().
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalise-third-party',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@storm-bet/')) return undefined;
          if (args.path.startsWith('node:')) return { path: args.path, external: true };
          return { path: args.path, external: true };
        });
      },
    },
  ],
  define: { 'process.env.STORM_BET_VERSION': JSON.stringify(pkg.version) },
});
