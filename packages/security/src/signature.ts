import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedRequestParts {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}

/**
 * HMAC-SHA256 request signing between the panel and node agents (and for
 * outbound webhooks). Binding method, path and timestamp into the signature
 * stops a captured request from being replayed against a different endpoint.
 */
export function signRequest(secret: string, parts: SignedRequestParts): string {
  const canonical = `${parts.method.toUpperCase()}\n${parts.path}\n${parts.timestamp}\n${hashBody(parts.body)}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifySignature(
  secret: string,
  parts: SignedRequestParts,
  signature: string,
  toleranceSeconds = 300,
): boolean {
  const ts = Number(parts.timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > toleranceSeconds) return false;

  const expected = signRequest(secret, parts);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hashBody(body: string): string {
  return createHmac('sha256', 'storm-body')
    .update(body ?? '')
    .digest('hex');
}

/** Signature header used for outbound webhooks (`t=<ts>,v1=<hmac>`). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}
