import path from 'node:path';
import fs from 'node:fs/promises';
import { assertNoSymlinkEscape, resolveSafePath, PathTraversalError } from '@storm/security';
import { AgentError } from './errors.js';

/**
 * Every filesystem operation on the agent funnels through here.
 *
 * The panel already normalises paths, but the agent must never trust that: it
 * is the only component with real filesystem access, so it re-validates and
 * additionally resolves symlinks, which the panel cannot do remotely.
 */
export class ServerPaths {
  constructor(private readonly dataDirectory: string) {}

  root(uuid: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
      throw new AgentError(400, 'VALIDATION_ERROR', 'Invalid server identifier');
    }
    return path.join(this.dataDirectory, uuid);
  }

  /** Resolves a customer-supplied path inside a server directory. */
  resolve(uuid: string, requested: string): string {
    try {
      return resolveSafePath(this.root(uuid), requested);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        throw new AgentError(400, 'PATH_NOT_ALLOWED', 'That path is outside the server directory');
      }
      throw error;
    }
  }

  /** Resolves and additionally proves the real path is not a symlink escape. */
  async resolveChecked(uuid: string, requested: string): Promise<string> {
    const target = this.resolve(uuid, requested);
    try {
      await assertNoSymlinkEscape(this.root(uuid), target);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        throw new AgentError(400, 'PATH_NOT_ALLOWED', error.message);
      }
      throw error;
    }
    return target;
  }

  async ensureRoot(uuid: string): Promise<string> {
    const root = this.root(uuid);
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    return root;
  }

  /** Path relative to the server root, always `/`-prefixed. */
  relative(uuid: string, absolute: string): string {
    const rel = path.relative(this.root(uuid), absolute);
    return `/${rel.split(path.sep).join('/')}`.replace(/\/+$/, '') || '/';
  }
}
