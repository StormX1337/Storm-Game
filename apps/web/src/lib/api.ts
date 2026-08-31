import type { ApiErrorBody, PaginationMeta } from '@storm/types';

/**
 * Browser API client.
 *
 * The panel is served from one origin (nginx routes `/api` to the backend), so
 * requests are same-origin and the session travels in an httpOnly cookie the
 * page cannot read. That removes the whole class of XSS-steals-your-token bugs
 * that comes with keeping a JWT in localStorage.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** First message for a field, for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0];
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the automatic refresh-and-retry on 401. */
  noRetry?: boolean;
}

const API_BASE = '/api/v1';

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Refreshes the session, coalescing concurrent callers: a dashboard can fire
 * six requests at once and they must not trigger six token rotations.
 */
async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see it.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, noRetry, headers, ...init } = options;

  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const isFormData = body instanceof FormData;
  const response = await fetch(url.toString(), {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(isFormData || body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: isFormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && !noRetry && !path.startsWith('/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, noRetry: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, 'INTERNAL_ERROR', await friendlyStatus(response));
    }
    return (await response.text()) as T;
  }

  const payload = (await response.json()) as { success: boolean; data?: T } | ApiErrorBody;

  if (!response.ok || payload.success === false) {
    const error = (payload as ApiErrorBody).error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? (await friendlyStatus(response)),
      error?.details,
      error?.requestId,
    );
  }

  return (payload as { data: T }).data;
}

async function friendlyStatus(response: Response): Promise<string> {
  switch (response.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'You do not have permission to do that.';
    case 404:
      return 'That resource could not be found.';
    case 429:
      return 'Too many requests. Please slow down and try again shortly.';
    case 502:
    case 503:
      return 'The panel is temporarily unavailable. Please try again in a moment.';
    default:
      return `Request failed (${response.status}).`;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'DELETE', body }),
};

/** Paginated endpoints return `{ data, meta }`; this keeps both. */
export async function apiPaginated<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ items: T[]; meta: PaginationMeta }> {
  const { body, query, headers, ...init } = options;

  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) return apiPaginated<T>(path, options);
  }

  const payload = (await response.json()) as
    | { success: true; data: T[]; meta: PaginationMeta }
    | ApiErrorBody;

  if (!response.ok || payload.success === false) {
    const error = (payload as ApiErrorBody).error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Request failed',
      error?.details,
    );
  }

  return {
    items: payload.data,
    meta: payload.meta ?? {
      page: 1,
      perPage: payload.data.length,
      total: payload.data.length,
      totalPages: 1,
    },
  };
}

/** Human-readable message for anything thrown by the client. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
