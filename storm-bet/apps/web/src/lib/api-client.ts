'use client';

import { CSRF_COOKIE, CSRF_HEADER } from '@storm-bet/config/constants';
import { ERROR_MESSAGES, isErrorCode, type ApiErrorBody, type ErrorCode } from '@storm-bet/types';

/** An API failure, already translated into the platform's error vocabulary. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field → message map from a VALIDATION_ERROR, for forms. */
  get fields(): Record<string, string> {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : {};
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** A request the server has not answered by then is reported, never left spinning. */
const REQUEST_TIMEOUT_MS = 30_000;

let csrfRequest: Promise<string> | null = null;

async function csrfToken(refresh = false): Promise<string> {
  const existing = refresh ? null : readCookie(CSRF_COOKIE);
  if (existing) return existing;
  csrfRequest ??= fetch('/api/auth/csrf', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((r) => r.json() as Promise<{ token: string }>)
    .then((b) => b.token)
    .finally(() => {
      csrfRequest = null;
    });
  return csrfRequest;
}

async function toError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const code = isErrorCode(body?.error?.code)
    ? body!.error!.code
    : response.status >= 500
      ? 'INTERNAL_ERROR'
      : 'VALIDATION_ERROR';
  return new ApiError(
    code,
    body?.error?.message ?? ERROR_MESSAGES[code],
    response.status,
    body?.error?.details,
  );
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T>(
  path: string,
  options: { method?: Method; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const send = async (refreshCsrf: boolean) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers[CSRF_HEADER] = await csrfToken(refreshCsrf);
    }
    return fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
  let response: Response;
  try {
    response = await send(false);
    // A stale CSRF cookie (e.g. after the session changed in another tab) is
    // renewed once, transparently.
    if (response.status === 403 && method !== 'GET') {
      const clone = response.clone();
      const body = (await clone.json().catch(() => null)) as ApiErrorBody | null;
      if (body?.error?.details?.reason === 'csrf') response = await send(true);
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw new ApiError(
      'SERVICE_UNAVAILABLE',
      timedOut
        ? 'Der Server antwortet nicht. Bitte versuche es gleich noch einmal.'
        : 'Keine Verbindung zum Server. Bitte prüfe deine Internetverbindung.',
      0,
      undefined,
    );
  }
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return ERROR_MESSAGES.INTERNAL_ERROR;
}
