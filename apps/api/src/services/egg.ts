import type { CreateTemplateInput } from '@storm/types';

/**
 * Reading a Pterodactyl egg.
 *
 * Every game that has ever been hosted has an egg for it, written by someone
 * who already solved the install script, and an operator moving to this panel
 * arrives with a folder full of them. Retyping that by hand is the reason they
 * do not move.
 *
 * The two formats are close relatives — both describe a container, a startup
 * line, an install script and a set of variables — so most of this is renaming.
 * What is not renaming is called out below, and anything that cannot survive
 * the crossing is reported rather than dropped quietly: an egg that arrives
 * subtly wrong is worse than one that was refused, because it fails later, on
 * somebody's server.
 */

/** What an import could not carry over, in words an operator can act on. */
export interface EggImportResult {
  template: CreateTemplateInput;
  warnings: string[];
}

interface EggVariable {
  name?: unknown;
  description?: unknown;
  env_variable?: unknown;
  default_value?: unknown;
  user_viewable?: unknown;
  user_editable?: unknown;
  rules?: unknown;
}

interface Egg {
  name?: unknown;
  author?: unknown;
  description?: unknown;
  startup?: unknown;
  docker_images?: unknown;
  images?: unknown;
  image?: unknown;
  meta?: unknown;
  config?: unknown;
  scripts?: unknown;
  variables?: unknown;
}

/** Parsers this panel can actually write. Pterodactyl also has `file` and `xml`. */
const SUPPORTED_PARSERS = new Set(['properties', 'ini', 'json', 'yaml']);

/**
 * Placeholders that mean the same thing under a different name.
 *
 * Longest first, because `server.build.default.port` also starts with
 * `server.build.` and a shorter rule would eat it.
 */
const PLACEHOLDERS: [RegExp, string][] = [
  [/server\.build\.default\.port/g, 'server.allocation.port'],
  [/server\.build\.default\.ip/g, 'server.allocation.ip'],
  [/server\.build\.env\./g, 'env.'],
];

/** Placeholders with no counterpart here, worth saying so rather than shipping. */
const UNTRANSLATABLE =
  /\{\{\s*(config\.[A-Za-z0-9_.]+|server\.build\.default\.[A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * Is this an egg rather than one of this panel's own exports?
 *
 * Checked on the shape rather than a version string alone: eggs have been
 * exported as PTDL_v1 and PTDL_v2, and plenty of the ones passed around have
 * had their `meta` block edited out entirely.
 */
export function isPterodactylEgg(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const egg = raw as Egg;

  const meta = egg.meta;
  if (typeof meta === 'object' && meta !== null) {
    const version = (meta as { version?: unknown }).version;
    if (typeof version === 'string' && version.toUpperCase().startsWith('PTDL_')) return true;
  }

  // A Storm export never has these; an egg always has both.
  const hasInstaller =
    typeof egg.scripts === 'object' &&
    egg.scripts !== null &&
    'installation' in (egg.scripts as object);
  return hasInstaller && typeof egg.startup === 'string';
}

/** Converts an egg into what this panel's template endpoints already accept. */
export function convertEgg(
  raw: unknown,
  overrides: { slug?: string; game?: string; category?: string } = {},
): EggImportResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('That file is not an egg: the top level is not an object.');
  }
  const egg = raw as Egg;
  const warnings: string[] = [];

  const name = text(egg.name);
  if (!name) throw new Error('That egg has no name.');

  const startup = text(egg.startup);
  if (!startup) throw new Error(`"${name}" has no startup command, so nothing could be run.`);

  const dockerImages = readImages(egg);
  if (Object.keys(dockerImages).length === 0) {
    throw new Error(`"${name}" names no docker image, so there is nothing to run it in.`);
  }
  const defaultImage = Object.values(dockerImages)[0] as string;

  const config = readJsonish(egg.config);
  const scripts = readJsonish(egg.scripts);
  const installation = readJsonish((scripts as { installation?: unknown }).installation);

  const { files, dropped } = readConfigFiles(readJsonish((config as { files?: unknown }).files));
  for (const entry of dropped) {
    warnings.push(
      `The rules for ${entry.path} use the "${entry.parser}" parser, which this panel cannot ` +
        'write. That file will not be kept in step with the server; edit it by hand or add the ' +
        'values to the install script.',
    );
  }

  const variables = readVariables(egg.variables, warnings);
  const startupDetection = readDone(readJsonish((config as { startup?: unknown }).startup));

  const unresolved = new Set<string>();
  const translate = (value: string): string => {
    const rewritten = rewritePlaceholders(value);
    for (const match of rewritten.matchAll(UNTRANSLATABLE)) unresolved.add(match[0]);
    return rewritten;
  };

  const template: CreateTemplateInput = {
    name,
    slug: overrides.slug?.trim() || slugify(name),
    game: overrides.game?.trim() || name,
    category: overrides.category?.trim() || 'Other',
    description: text(egg.description).slice(0, 4000),
    author: text(egg.author).slice(0, 255) || 'Imported egg',
    dockerImages,
    defaultImage,
    startupCommand: translate(startup).slice(0, 4000),
    stopCommand: text((config as { stop?: unknown }).stop) || '^C',
    installScript: text((installation as { script?: unknown }).script) || '#!/bin/bash\n',
    installContainer:
      text((installation as { container?: unknown }).container) || 'debian:bookworm-slim',
    installEntrypoint: text((installation as { entrypoint?: unknown }).entrypoint) || 'bash',
    startupDetection: startupDetection.slice(0, 500),
    crashDetection: '',
    configFiles: Object.fromEntries(
      Object.entries(files).map(([path, definition]) => [
        path,
        {
          parser: definition.parser,
          find: Object.fromEntries(
            Object.entries(definition.find).map(([key, value]) => [key, translate(value)]),
          ),
        },
      ]),
    ),
    logConfig: readJsonish((config as { logs?: unknown }).logs) as Record<string, unknown>,
    defaultPorts: [],
    supportedVersions: [],
    // Deliberately empty. An egg's "features" are Pterodactyl's install
    // helpers (eula, java_version); this panel's are its own optional pages,
    // and mapping one onto the other by name would turn on a plugin manager
    // for a game that has no plugins.
    features: [],
    variables,
    // Active on arrival: the point of importing is to build on it, and an
    // operator who wanted it hidden can turn it off in one click.
    isActive: true,
  };

  if (unresolved.size > 0) {
    warnings.push(
      `This panel has no equivalent for ${[...unresolved].join(', ')}. Those are left as written ` +
        'and will reach the server literally — replace them before anyone builds on this template.',
    );
  }

  return { template, warnings };
}

/* ------------------------------------------------------------------ parts -- */

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** An egg's nested blocks are sometimes objects and sometimes JSON strings. */
function readJsonish(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Three generations of the same field: a labelled map, a bare list, and a
 * single string. All three are still in circulation.
 */
function readImages(egg: Egg): Record<string, string> {
  const images: Record<string, string> = {};

  if (typeof egg.docker_images === 'object' && egg.docker_images !== null) {
    for (const [label, image] of Object.entries(egg.docker_images as Record<string, unknown>)) {
      if (typeof image === 'string' && image.trim()) images[label.trim() || image] = image.trim();
    }
  }
  if (Object.keys(images).length === 0 && Array.isArray(egg.images)) {
    for (const image of egg.images) {
      if (typeof image === 'string' && image.trim()) images[labelFor(image)] = image.trim();
    }
  }
  if (Object.keys(images).length === 0 && typeof egg.image === 'string' && egg.image.trim()) {
    images[labelFor(egg.image)] = egg.image.trim();
  }
  return images;
}

/** A readable name for an image that arrived without one. */
function labelFor(image: string): string {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
  const repository = image.split('/').pop()?.split(':')[0] ?? image;
  return tag ? `${repository} ${tag}` : repository;
}

function rewritePlaceholders(value: string): string {
  let output = value;
  for (const [pattern, replacement] of PLACEHOLDERS) output = output.replace(pattern, replacement);
  return output;
}

interface ConfigFile {
  parser: string;
  find: Record<string, string>;
}

function readConfigFiles(raw: Record<string, unknown>): {
  files: Record<string, ConfigFile>;
  dropped: { path: string; parser: string }[];
} {
  const files: Record<string, ConfigFile> = {};
  const dropped: { path: string; parser: string }[] = [];

  for (const [path, definition] of Object.entries(raw)) {
    const block = readJsonish(definition);
    const parser = text(block.parser);
    const find = readJsonish(block.find);

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(find)) {
      // Pterodactyl allows a nested object here for structured formats. This
      // panel takes a dotted key, so flatten rather than lose the setting.
      if (typeof value === 'string') entries[key] = value;
      else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
          if (typeof innerValue === 'string') entries[`${key}.${inner}`] = innerValue;
        }
      }
    }
    if (Object.keys(entries).length === 0) continue;

    if (!SUPPORTED_PARSERS.has(parser)) {
      dropped.push({ path, parser: parser || 'unknown' });
      continue;
    }
    files[path] = { parser, find: entries };
  }

  return { files, dropped };
}

/** The line an egg watches for to call a server started. */
function readDone(startup: Record<string, unknown>): string {
  const done = startup.done;
  if (typeof done === 'string') return done;
  if (Array.isArray(done)) {
    const first = done.find((entry) => typeof entry === 'string');
    return typeof first === 'string' ? first : '';
  }
  return '';
}

function readVariables(raw: unknown, warnings: string[]): CreateTemplateInput['variables'] {
  if (!Array.isArray(raw)) return [];

  const variables: CreateTemplateInput['variables'] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const variable = entry as EggVariable;

    const envVariable = text(variable.env_variable).toUpperCase();
    // The panel keys a server's environment on this, and the database has a
    // unique index per template, so a duplicate would fail the whole import.
    if (!/^[A-Z_][A-Z0-9_]*$/.test(envVariable) || seen.has(envVariable)) {
      if (envVariable) {
        warnings.push(
          `Variable "${envVariable}" was skipped: ${seen.has(envVariable) ? 'it appears twice' : 'that is not a usable environment variable name'}.`,
        );
      }
      return;
    }
    seen.add(envVariable);

    variables.push({
      name: text(variable.name).slice(0, 100) || envVariable,
      description: text(variable.description).slice(0, 1000),
      envVariable,
      defaultValue: rewritePlaceholders(text(variable.default_value)).slice(0, 500),
      userViewable: truthy(variable.user_viewable, true),
      userEditable: truthy(variable.user_editable, true),
      rules: translateRules(text(variable.rules), envVariable, warnings),
      sortOrder: index,
    });
  });

  return variables;
}

/** Eggs have carried this as a boolean, a number and the strings "1" and "0". */
function truthy(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  return fallback;
}

/**
 * Laravel rule strings, which both panels use — with one difference that
 * matters.
 *
 * Pterodactyl writes a regex the way PHP does, wrapped in delimiters:
 * `regex:/^([\w.-]+)(\.jar)$/`. This panel hands the argument straight to
 * `new RegExp`, where those slashes are literal characters, so the rule would
 * match nothing and every value for that variable would be refused.
 *
 * The other difference is structural. Rules are split on `|`, so a pattern
 * containing an alternation is torn in half by the parser. Nothing can be done
 * about that here, so the pattern is dropped and said out loud — the variable
 * keeps its other checks, and the operator learns which one to re-add.
 */
export function translateRules(rules: string, envVariable: string, warnings: string[]): string {
  if (!rules) return 'string';

  const kept: string[] = [];
  for (const rule of splitRules(rules)) {
    if (!rule) continue;
    if (!rule.startsWith('regex:')) {
      kept.push(rule);
      continue;
    }

    const pattern = unwrapPhpRegex(rule.slice('regex:'.length));
    if (pattern === null) {
      warnings.push(
        `The pattern on ${envVariable} could not be read and was dropped. Its other checks are ` +
          'kept.',
      );
      continue;
    }
    if (pattern.includes('|')) {
      warnings.push(
        `The pattern on ${envVariable} contains "|", which this panel reads as the end of a rule, ` +
          'so it was dropped. Its other checks are kept.',
      );
      continue;
    }
    kept.push(`regex:${pattern}`);
  }

  return kept.join('|') || 'string';
}

/**
 * Splits a rule string on `|`, except inside a pattern.
 *
 * `required|regex:/^(paper|purpur)$/|max:10` is four rules to a naive split and
 * three to a reader. Splitting first and asking questions afterwards left the
 * tail of the pattern standing as a rule of its own — which is how the panel
 * ends up with `purpur)$/` in its validator. The pattern is put back together
 * here so the decision about it can be made on the whole thing.
 */
function splitRules(rules: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let inside: string | null = null;

  for (let index = 0; index < rules.length; index += 1) {
    const character = rules[index]!;

    if (inside) {
      buffer += character;
      // An escaped delimiter is part of the pattern, not the end of it.
      if (character === inside && rules[index - 1] !== '\\') inside = null;
      continue;
    }
    if (character === '|') {
      parts.push(buffer);
      buffer = '';
      continue;
    }

    buffer += character;
    if (buffer.trim() === 'regex:') {
      const next = rules[index + 1];
      if (next && '/#~%'.includes(next)) {
        inside = next;
        buffer += next;
        index += 1;
      }
    }
  }
  parts.push(buffer);

  return parts.map((part) => part.trim()).filter(Boolean);
}

/** `/^x$/i` -> `^x$`, and anything already bare is returned unchanged. */
function unwrapPhpRegex(raw: string): string | null {
  const pattern = raw.trim();
  if (pattern === '') return null;

  const delimiter = pattern[0]!;
  if (!'/#~%'.includes(delimiter)) return pattern;

  const end = pattern.lastIndexOf(delimiter);
  if (end <= 0) return null;
  return pattern.slice(1, end);
}

/** A slug from a name, for eggs, which have no slug of their own. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');
  return slug || 'imported-template';
}
