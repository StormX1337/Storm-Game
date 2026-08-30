const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'secretkey',
  'accesskey',
  'authorization',
  'cookie',
  'setcookie',
  'totp',
  'code',
  'backupcodes',
  'apikey',
  'privatekey',
  'sftppassword',
];

/** Recursively replaces sensitive values so they never reach logs or audit rows. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.includes(key.toLowerCase().replace(/[_-]/g, ''))) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}
