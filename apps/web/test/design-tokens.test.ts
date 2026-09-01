import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.resolve(HERE, '../../../packages/ui/src/styles.css');
const TAILWIND = path.resolve(HERE, '../tailwind.config.ts');

/**
 * A custom property used by a Tailwind utility but defined in neither theme is
 * the quietest failure in the whole design system: the browser drops the
 * declaration, the element renders with no shadow or a transparent colour, and
 * nothing anywhere says so. One defined in `:root` but forgotten in `.dark` is
 * worse — light-mode values leak into the dark theme and only a human looking
 * at the screen notices.
 *
 * So the tokens are read from the stylesheet and the Tailwind theme is read
 * from its config, and the two are checked against each other.
 */

/** Every `--name: value` inside the given selector's block. */
function tokensIn(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in styles.css`);

  // Blocks here contain no nested braces, so the first `}` ends this one.
  const end = css.indexOf('\n  }', start);
  const block = css.slice(start, end === -1 ? undefined : end);

  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.replace(/\s+/g, ' ').trim());
  }
  return found;
}

/** The custom properties a value refers to, e.g. `var(--shadow-sm), …`. */
function referenced(value: string): string[] {
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]!);
}

const css = readFileSync(TOKENS, 'utf8');
const light = tokensIn(css, ':root');
const dark = tokensIn(css, '.dark');

const config = readFileSync(TAILWIND, 'utf8');

/** Custom properties the Tailwind theme resolves, by the utility that uses them. */
function themeReferences(key: string): string[] {
  const start = config.indexOf(`${key}: {`);
  if (start === -1) throw new Error(`no ${key} map in tailwind.config.ts`);
  const end = config.indexOf('\n      },', start);
  return referenced(config.slice(start, end === -1 ? undefined : end));
}

describe('design tokens', () => {
  it('defines every custom property the Tailwind theme resolves', () => {
    const used = [...themeReferences('colors'), ...themeReferences('boxShadow')];
    expect(used.length).toBeGreaterThan(20);

    const missing = used.filter((token) => !light.has(token));
    expect(missing, `used by Tailwind but never defined: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives the dark theme its own value for every colour', () => {
    // A colour is a colour wherever it is used, so both themes must name one.
    // Shape tokens — a radius, a shadow *composition* — are deliberately
    // shared and are checked separately below.
    const colours = themeReferences('colors');
    const missing = colours.filter((token) => !dark.has(token));
    expect(missing, `light-only colour tokens: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives the dark theme its own value for every shadow that carries colour', () => {
    // `--elevation-card` is a composition — `var(--shadow-sm), var(--highlight)`
    // — and is shared on purpose: what changes between themes is what those
    // two resolve to. Anything that names a colour itself must be redefined,
    // or the dark panel wears light mode's shadows.
    const queue = [...themeReferences('boxShadow')];
    const seen = new Set<string>();
    const carriesColour: string[] = [];

    while (queue.length > 0) {
      const token = queue.pop()!;
      if (seen.has(token)) continue;
      seen.add(token);

      const value = light.get(token);
      if (value === undefined) continue; // reported by the first test
      queue.push(...referenced(value));
      if (/hsl\(|rgba?\(|#[0-9a-f]{3,8}\b/i.test(value)) carriesColour.push(token);
    }

    expect(carriesColour.length).toBeGreaterThan(3);
    const missing = carriesColour.filter((token) => !dark.has(token));
    expect(missing, `shadow tokens with no dark value: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the default brand colour on the token the stylesheet ships', () => {
    // `useBrandColor` overwrites --primary on the root element. If the
    // stylesheet's own light value ever drifts from the default hex an
    // administrator sees in the settings form, every panel that never touched
    // the setting shifts hue the first time somebody opens that page and
    // presses save.
    expect(light.get('--primary')).toBe('221 83% 53%');
    expect(light.get('--accent')).toBe(light.get('--primary'));
    expect(light.get('--ring')).toBe(light.get('--primary'));
    expect(dark.get('--accent')).toBe(dark.get('--primary'));
    expect(dark.get('--ring')).toBe(dark.get('--primary'));
  });
});
