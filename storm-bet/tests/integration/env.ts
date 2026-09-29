// Integration tests run against a dedicated database so they never touch
// development data. Override TEST_DATABASE_URL / TEST_REDIS_URL in CI.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://stormbet:stormbet@localhost:5432/stormbet_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';
