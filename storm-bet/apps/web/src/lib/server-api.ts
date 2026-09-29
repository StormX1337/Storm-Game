import 'server-only';
import type { PlatformMetaDto, SessionUserDto } from '@storm-bet/types';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Server-side call to the API on behalf of the visitor: their cookies are
 * forwarded, so the API applies exactly the same authorisation as for a
 * browser request. Nothing here bypasses the API.
 */
export async function serverApi<T>(path: string): Promise<T> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const forwarded = headerStore.get('x-forwarded-for');
  const response = await fetch(`${API}/api${path}`, {
    headers: {
      accept: 'application/json',
      cookie: cookieStore.toString(),
      ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
      'user-agent': headerStore.get('user-agent') ?? 'storm-bet-web',
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    let code = 'INTERNAL_ERROR';
    let message = 'Fehler';
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // keep defaults
    }
    throw new ServerApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

/** Same as serverApi, but a failure yields null (for optional page sections). */
export async function tryServerApi<T>(path: string): Promise<T | null> {
  try {
    return await serverApi<T>(path);
  } catch {
    return null;
  }
}

/** The visitor's session user, fetched once per request. */
export const getSessionUser = cache(async (): Promise<SessionUserDto | null> => {
  const result = await tryServerApi<{ user: SessionUserDto | null }>('/auth/session');
  return result?.user ?? null;
});

const UNKNOWN_FEED: PlatformMetaDto = {
  realMoney: false,
  odds: { provider: 'unknown', name: 'unbekannt', isSimulated: true },
};

/** Which odds feed the platform runs on. If it cannot be determined, data is labelled simulated. */
export const getPlatformMeta = cache(
  async (): Promise<PlatformMetaDto> =>
    (await tryServerApi<PlatformMetaDto>('/meta')) ?? UNKNOWN_FEED,
);
