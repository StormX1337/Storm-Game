import path from 'node:path';
import fs from 'node:fs/promises';

export class PathTraversalError extends Error {
  constructor(message = 'Path escapes the permitted directory') {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolves a user supplied path against a root directory and guarantees the
 * result stays inside it.
 *
 * Defends against:
 *   - `../` traversal, including encoded and repeated forms
 *   - absolute paths (`/etc/passwd`) — they are treated as root-relative
 *   - null bytes
 *   - Windows-style separators smuggled through a Linux API
 *
 * Symlinks are handled separately by `assertNoSymlinkEscape`, which must be
 * called for operations that follow links (read/write/delete).
 */
export function resolveSafePath(root: string, requested: string): string {
  if (requested.includes('\0')) {
    throw new PathTraversalError('Path contains a null byte');
  }

  const normalizedRoot = path.resolve(root);
  // Treat every incoming path as relative to the root, never to the FS root.
  const relative = requested.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(normalizedRoot, relative);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new PathTraversalError();
  }
  return resolved;
}

/**
 * Verifies that the real (symlink-resolved) location of `target` is still
 * inside `root`. Walks up to the nearest existing ancestor so it also protects
 * *creation* inside a symlinked directory.
 */
export async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const normalizedRoot = await fs.realpath(path.resolve(root));
  let current = path.resolve(target);

  // Find the deepest component that actually exists.
  for (;;) {
    try {
      const real = await fs.realpath(current);
      if (real !== normalizedRoot && !real.startsWith(normalizedRoot + path.sep)) {
        throw new PathTraversalError('Path resolves outside the server directory via a symlink');
      }
      return;
    } catch (error) {
      if (error instanceof PathTraversalError) throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new PathTraversalError('Unable to resolve path');
      }
      current = parent;
    }
  }
}

/** Strips directory components and dangerous characters from an upload name. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\0-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'unnamed';
  }
  return cleaned.slice(0, 255);
}

/** Normalises a path for display/storage: always `/`-prefixed, no trailing slash. */
export function normalizeDisplayPath(input: string): string {
  const cleaned = path.posix.normalize(`/${input.replace(/\\/g, '/')}`);
  const stripped = cleaned.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}
