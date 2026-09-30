import { EN } from './en';
import { EN_PATTERNS } from './en-patterns';
import type { Locale } from './locale';

type Var = string | number | null | undefined;
export type TVars = Record<string | number, Var> | Var[];
export type T = (text: string | null | undefined, vars?: TVars) => string;

function fill(text: string, vars?: TVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = (vars as Record<string, Var>)[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * The German text is the key: German returns it as written, English looks it
 * up (then tries patterns for texts with numbers), and anything missing stays
 * German rather than showing a key.
 */
export function translate(locale: Locale, text: string | null | undefined, vars?: TVars): string {
  if (!text) return '';
  if (locale === 'de') return fill(text, vars);
  const exact = EN[text];
  if (exact !== undefined) return fill(exact, vars);
  const filled = fill(text, vars);
  const direct = EN[filled];
  if (direct !== undefined) return direct;
  // Fragments around links keep their outer spaces.
  const core = text.trim();
  if (core !== text && EN[core] !== undefined) {
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    return lead + fill(EN[core]!, vars) + trail;
  }
  // A market label with its line: "Tore Über/Unter 2.5".
  const lined = /^(.*\S) ([+−–-]?\d+(?:[.,]\d+)?)$/.exec(filled);
  if (lined && EN[lined[1]!] !== undefined) return `${EN[lined[1]!]} ${lined[2]}`;
  for (const [pattern, replace] of EN_PATTERNS) {
    if (pattern.test(filled))
      return typeof replace === 'string'
        ? filled.replace(pattern, replace)
        : filled.replace(pattern, (...m: string[]) => replace(...m));
  }
  return filled;
}

export const translator =
  (locale: Locale): T =>
  (text, vars) =>
    translate(locale, text, vars);
