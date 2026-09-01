import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = path.resolve(HERE, '../../../packages/ui/src/styles.css');
const SOURCES = [path.resolve(HERE, '../src'), path.resolve(HERE, '../../../packages/ui/src')];

/**
 * The design system has a handful of things Tailwind cannot express — a
 * pressed key's inverted gradient, a segmented control's raised segment — and
 * those live as `storm-*` classes and `storm-*` keyframes in the stylesheet,
 * referenced by name from the components.
 *
 * A name is a joint with no compiler across it. Rename the class and the
 * button keeps rendering, minus its shading; drop a keyframe and the status
 * dot simply stops pulsing. Neither throws, neither fails a rendering test,
 * and both look like nothing at all in a diff. So the two sides are read off
 * disk and compared.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * The `storm-*` tokens a file uses as CSS classes.
 *
 * Only class positions count: a `className` attribute, or an argument to `cn`
 * or `cva`. The panel also prints strings like `journalctl -u storm-updater`
 * as page copy, and a test that counted those would fail for a reason that
 * has nothing to do with the stylesheet.
 */
function classNamesIn(source: string): Set<string> {
  const found = new Set<string>();

  const collect = (text: string): void => {
    for (const literal of text.matchAll(/(['"`])([^'"`]*)\1/g)) {
      for (const token of literal[2]!.split(/\s+/)) {
        // Strip a Tailwind variant prefix (`hover:storm-key`) before matching.
        const bare = token.slice(token.lastIndexOf(':') + 1);
        if (bare.startsWith('storm-')) found.add(bare);
      }
    }
  };

  for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) collect(`"${match[1]!}"`);

  // These calls span lines and nest, so each extent is found by counting
  // brackets rather than by a regex that would stop at the first `)`.
  for (const match of source.matchAll(/\b(?:cn|cva)\(/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index]!;
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    collect(source.slice(start, index - 1));
  }

  return found;
}

/** The `storm-*` animations a file asks the browser to run. */
function animationsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/animation:\s*(['"`])\s*(storm-[\w-]+)/g)) {
    found.add(match[2]!);
  }
  return found;
}

const css = readFileSync(STYLES, 'utf8');
const definedClasses = new Set(
  [...css.matchAll(/^\s*\.(storm-[\w-]+)\s*[,{]/gm)].map((match) => match[1]!),
);
const definedKeyframes = new Set(
  [...css.matchAll(/@keyframes\s+(storm-[\w-]+)/g)].map((match) => match[1]!),
);

const files = SOURCES.flatMap(sourceFiles);
const usedClasses = new Set<string>();
const usedAnimations = new Set<string>();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const name of classNamesIn(source)) usedClasses.add(name);
  for (const name of animationsIn(source)) usedAnimations.add(name);
}

describe('storm-* design classes', () => {
  it('reads a source tree worth checking', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(usedClasses.size).toBeGreaterThan(3);
    expect(usedAnimations.size).toBeGreaterThan(0);
  });

  it('defines every class a component asks for', () => {
    const missing = [...usedClasses].filter((name) => !definedClasses.has(name)).sort();
    expect(missing, `used in markup, absent from styles.css: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines every keyframe a component animates by name', () => {
    const missing = [...usedAnimations].filter((name) => !definedKeyframes.has(name)).sort();
    expect(missing, `animated but never declared: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries no class the panel has stopped using', () => {
    // Dead rules in a shared stylesheet are worse than missing ones: the next
    // person finds `.storm-panel`, uses it, and it drifts from the component
    // that was quietly doing the same job.
    const orphans = [...definedClasses].filter((name) => !usedClasses.has(name)).sort();
    expect(orphans, `defined in styles.css, used nowhere: ${orphans.join(', ')}`).toEqual([]);
  });
});
