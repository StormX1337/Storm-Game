import 'server-only';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, toLocale, type Locale } from './locale';
import { translator, type T } from './translate';

export async function getLocale(): Promise<Locale> {
  return toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

/** Translator for server components: `const t = await getT();` */
export async function getT(): Promise<T> {
  return translator(await getLocale());
}
