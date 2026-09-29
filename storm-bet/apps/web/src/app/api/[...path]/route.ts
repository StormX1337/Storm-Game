import type { NextRequest } from 'next/server';

/**
 * Same-origin proxy to the API. The browser only ever talks to this origin, so
 * the session cookie can be httpOnly + SameSite and there is no CORS surface.
 * Bodies and responses are streamed (the live event stream included).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const FORWARD_REQUEST = [
  'accept',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'x-csrf-token',
  'sec-fetch-site',
  'x-forwarded-for',
  'last-event-id',
];
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
]);

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const target = new URL(`/api/${path.map(encodeURIComponent).join('/')}`, API);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));
  headers.set('x-forwarded-host', request.headers.get('host') ?? '');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
      cache: 'no-store',
      // Required by undici for streaming request bodies.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    return Response.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Der Dienst ist vorübergehend nicht verfügbar.',
        },
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) responseHeaders.set(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
