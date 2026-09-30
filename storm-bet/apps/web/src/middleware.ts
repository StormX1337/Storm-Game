import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce. Next.js reads the nonce
 * from the request header and attaches it to its own scripts; no inline script
 * without it can run, which neutralises injected markup even if it got in.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|icons/|manifest.webmanifest|robots.txt).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
