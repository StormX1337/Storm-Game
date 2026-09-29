import type { CookieSerializeOptions } from '@fastify/cookie';

export function cookieOptions(appUrl: string, maxAgeSeconds?: number): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    // Lax: sent on top-level navigation (links from mails work) but not on
    // cross-site POSTs, which together with the CSRF token closes CSRF.
    sameSite: 'lax',
    secure: appUrl.startsWith('https://'),
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}
