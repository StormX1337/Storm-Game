export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = 'lang';
export const DEFAULT_LOCALE: Locale = 'de';

export function toLocale(value: string | undefined | null): Locale {
  return value === 'en' ? 'en' : 'de';
}
