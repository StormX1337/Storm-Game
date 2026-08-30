import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../lib/errors.js';

/**
 * The node installer and the agent bundle it downloads.
 *
 * Unauthenticated on purpose: an operator runs this on a bare machine that has
 * no credentials yet, and neither file contains a secret — the node's token is
 * supplied by the operator when the installer prompts for it. Serving the
 * bundle from the panel also means a node always gets the agent build that
 * matches the panel which issued its token.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from this file looking for the repository root. In development that
 * is `apps/api/src/routes` → four levels; in the container the API runs from
 * `apps/api/dist/routes`. Rather than hard-coding either, find the marker.
 */
async function repoRoot(): Promise<string | null> {
  let current = HERE;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await fs.access(path.join(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

export default async function installRoutes(app: FastifyInstance): Promise<void> {
  const root = await repoRoot();

  const scriptPath = root
    ? await firstExisting([path.join(root, 'scripts', 'install-node.sh')])
    : null;

  // Built by scripts/build-agent-bundle.sh, which the API image runs at build
  // time. AGENT_BUNDLE_PATH overrides it for operators who stage it elsewhere.
  const bundleCandidates = [
    ...(process.env.AGENT_BUNDLE_PATH ? [process.env.AGENT_BUNDLE_PATH] : []),
    ...(root ? [path.join(root, 'dist', 'storm-agent.tar.gz')] : []),
  ];

  app.get(
    '/install/node.sh',
    { schema: { tags: ['Nodes'], summary: 'The node agent installer script' } },
    async (_request, reply) => {
      if (!scriptPath) throw notFound('The installer script is not available on this panel');

      const script = await fs.readFile(scriptPath, 'utf8');
      return reply
        .type('text/x-shellscript; charset=utf-8')
        .header('content-disposition', 'attachment; filename="install-node.sh"')
        .header('cache-control', 'no-cache')
        .send(script);
    },
  );

  app.get(
    '/install/storm-agent.tar.gz',
    { schema: { tags: ['Nodes'], summary: 'The node agent bundle' } },
    async (_request, reply) => {
      const bundle = await firstExisting(bundleCandidates);
      if (!bundle) {
        // The installer falls back to building from a checkout, so say what is
        // missing rather than leaving the operator with a bare 404.
        throw notFound(
          'No agent bundle is published on this panel. Build one with scripts/build-agent-bundle.sh',
        );
      }

      const stat = await fs.stat(bundle);
      return reply
        .type('application/gzip')
        .header('content-disposition', 'attachment; filename="storm-agent.tar.gz"')
        .header('content-length', String(stat.size))
        .send(createReadStream(bundle));
    },
  );
}
