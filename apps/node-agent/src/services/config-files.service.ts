import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AgentConfigFile } from '@storm/types';
import { resolveSafePath } from '@storm/security';

/**
 * Rewrites a game's own configuration files so they agree with the allocation
 * and limits the panel gave the server. Without this a customer moved to a new
 * port has to edit `server.properties` by hand, and half of them will not.
 *
 * Applied immediately before every start, which makes it self-healing: a
 * customer who edits the port back is corrected on the next boot.
 *
 * The panel resolves placeholders before sending these, so everything here is
 * a literal string. Paths are resolved inside the server's directory with the
 * same guard the file manager uses — a template is operator-supplied, but it
 * still does not get to write outside the server it belongs to.
 */
export async function applyConfigFiles(
  root: string,
  files: AgentConfigFile[],
  log: { warn: (message: string) => void },
): Promise<void> {
  for (const file of files) {
    try {
      await applyOne(root, file);
    } catch (error) {
      // A bad mapping must not stop a server from booting; the game's own
      // defaults are a better outcome than a server that will not start.
      log.warn(
        `Could not apply config file ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function applyOne(root: string, file: AgentConfigFile): Promise<void> {
  const target = resolveSafePath(root, file.path);
  const entries = Object.entries(file.find);
  if (entries.length === 0) return;

  const existing = await readIfPresent(target);

  let next: string;
  switch (file.parser) {
    case 'properties':
      next = applyProperties(existing ?? '', entries);
      break;
    case 'ini':
      next = applyIni(existing ?? '', entries);
      break;
    case 'json':
      next = applyJson(existing ?? '{}', entries);
      break;
    case 'yaml':
      next = applyYaml(existing ?? '', entries);
      break;
    default: {
      const parser: never = file.parser;
      throw new Error(`Unsupported parser: ${String(parser)}`);
    }
  }

  if (next === existing) return;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, next, 'utf8');
  // The game runs unprivileged; a file the agent created must still be its own.
  await fs.chown(target, 1000, 1000).catch(() => undefined);
}

async function readIfPresent(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * `key=value`, one per line. Comments, blank lines and ordering are preserved —
 * this file usually belongs to the customer, and we are only visiting.
 */
function applyProperties(source: string, entries: [string, string][]): string {
  const wanted = new Map(entries);
  const lines = source.split('\n');

  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;

    const separator = line.indexOf('=');
    if (separator === -1) return line;

    const key = line.slice(0, separator).trim();
    if (!wanted.has(key)) return line;

    const value = wanted.get(key) as string;
    wanted.delete(key);
    return `${key}=${value}`;
  });

  // Anything the file did not already have gets appended.
  for (const [key, value] of wanted) {
    if (output.length > 0 && output[output.length - 1]?.trim() !== '') output.push('');
    output[output.length - 1] = `${key}=${value}`;
    output.push('');
  }

  return output.join('\n');
}

/** `[section]` headers with `key = value` beneath; keys are `section.key`. */
function applyIni(source: string, entries: [string, string][]): string {
  const wanted = new Map(entries);
  const lines = source.split('\n');
  let section = '';

  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).trim();
      return line;
    }
    if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#')) return line;

    const separator = line.indexOf('=');
    if (separator === -1) return line;

    const key = line.slice(0, separator).trim();
    const qualified = section ? `${section}.${key}` : key;
    if (!wanted.has(qualified)) return line;

    const value = wanted.get(qualified) as string;
    wanted.delete(qualified);
    return `${key}=${value}`;
  });

  // Missing keys are grouped back under their sections rather than dumped at
  // the end, where an INI parser would read them as part of the last section.
  const bySection = new Map<string, [string, string][]>();
  for (const [qualified, value] of wanted) {
    const index = qualified.indexOf('.');
    const name = index === -1 ? '' : qualified.slice(0, index);
    const key = index === -1 ? qualified : qualified.slice(index + 1);
    const bucket = bySection.get(name) ?? [];
    bucket.push([key, value]);
    bySection.set(name, bucket);
  }

  for (const [name, pairs] of bySection) {
    if (output.length > 0 && output[output.length - 1]?.trim() !== '') output.push('');
    if (name) output.push(`[${name}]`);
    for (const [key, value] of pairs) output.push(`${key}=${value}`);
  }

  return output.join('\n');
}

function applyJson(source: string, entries: [string, string][]): string {
  const parsed: unknown = source.trim() === '' ? {} : JSON.parse(source);
  const document = isRecord(parsed) ? parsed : {};

  for (const [key, value] of entries) setDeep(document, key.split('.'), coerce(value));
  return `${JSON.stringify(document, null, 2)}\n`;
}

function applyYaml(source: string, entries: [string, string][]): string {
  const parsed: unknown = source.trim() === '' ? {} : YAML.parse(source);
  const document = isRecord(parsed) ? parsed : {};

  for (const [key, value] of entries) setDeep(document, key.split('.'), coerce(value));
  return YAML.stringify(document);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Writes `a.b.c`, creating the intermediate objects it needs. */
function setDeep(target: Record<string, unknown>, keys: string[], value: unknown): void {
  const [head, ...rest] = keys;
  if (head === undefined) return;

  if (rest.length === 0) {
    target[head] = value;
    return;
  }

  const existing = target[head];
  const child = isRecord(existing) ? existing : {};
  target[head] = child;
  setDeep(child, rest, value);
}

/**
 * Structured formats want real types: a port written as `"25565"` is rejected
 * by most games, and `"true"` is not a boolean.
 */
function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return value;
}
