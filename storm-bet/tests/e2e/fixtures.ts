import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/** A documentation-range address (198.18.0.0/15), different for every call. */
export function clientIp() {
  const n = () => Math.floor(Math.random() * 254) + 1;
  return `198.18.${n()}.${n()}`;
}

/**
 * Every test acts as its own client with its own address, like real players do.
 * Otherwise the whole suite shares 127.0.0.1 and runs into the per-IP limits.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, 'x-forwarded-for': clientIp() });
  },
});
