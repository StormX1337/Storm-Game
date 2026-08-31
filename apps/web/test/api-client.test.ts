import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiRequest } from '@/lib/api';

/**
 * The client refreshes an expired session and retries, once. Getting this
 * wrong is quiet and expensive: too eager and a dashboard's six parallel
 * requests rotate the refresh token six times, which the API treats as token
 * reuse and revokes the whole session; too timid and every expiry logs the
 * customer out mid-click.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok = (data: unknown) => jsonResponse(200, { success: true, data });
const unauthorized = () =>
  jsonResponse(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'Session expired' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  // The client keeps one in-flight refresh so parallel callers share it, and
  // clears it on the next tick. Let that run, or the next test inherits a
  // resolved refresh and never calls /auth/refresh at all.
  await new Promise((resolve) => setTimeout(resolve, 1));
  vi.unstubAllGlobals();
});

const urlOf = (call: unknown[]) => String(call[0]);

describe('apiRequest', () => {
  it('unwraps the envelope so callers see their data, not the wrapper', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'srv_1', name: 'Survival' }));
    await expect(api.get('/servers/srv_1')).resolves.toEqual({ id: 'srv_1', name: 'Survival' });
  });

  it('refreshes once on a 401 and replays the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ refreshed: true }))
      .mockResolvedValueOnce(ok({ id: 'srv_1' }));

    await expect(api.get('/servers/srv_1')).resolves.toEqual({ id: 'srv_1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/auth/refresh');
    expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/servers/srv_1');
  });

  it('gives up after one retry instead of looping', async () => {
    // A 401 that survives a successful refresh means the session is genuinely
    // gone; retrying again would spin.
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ refreshed: true }))
      .mockResolvedValueOnce(unauthorized());

    await expect(api.get('/servers/srv_1')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not try to refresh a failed sign-in', async () => {
    // /auth/login answering 401 means wrong password, not an expired session.
    fetchMock.mockResolvedValueOnce(unauthorized());

    await expect(api.post('/auth/login', {})).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the failure when the refresh itself is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'no' } }));

    const error = await api.get('/servers').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isAuthError).toBe(true);
    // The original request is not replayed when the refresh failed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into one token rotation', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return Promise.resolve(ok({ refreshed: true }));
      // Every resource 401s once; after the refresh they would all succeed,
      // but the retry carries noRetry so each is attempted exactly twice.
      return Promise.resolve(unauthorized());
    });

    await Promise.allSettled([api.get('/a'), api.get('/b'), api.get('/c')]);

    const refreshes = fetchMock.mock.calls.filter((call) => urlOf(call).includes('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('carries the field errors the API sent, for inline form messages', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The submitted data is invalid',
          details: { email: ['Invalid email'] },
        },
      }),
    );

    const error = (await api.post('/auth/register', {}).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ email: ['Invalid email'] });
  });

  it('reports a network failure as an error rather than a hang', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.get('/servers')).rejects.toBeTruthy();
  });

  it('drops empty query values instead of sending ?search=', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    await apiRequest('/servers', { query: { page: 1, search: '', status: undefined } });

    const url = urlOf(fetchMock.mock.calls[0]!);
    expect(url).toContain('page=1');
    expect(url).not.toContain('search=');
    expect(url).not.toContain('status=');
  });
});
