import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvError, parseEnv, workerEnvSchema } from '../src';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    const env = parseEnv(apiEnvSchema, base);
    expect(env.API_PORT).toBe(4000);
    expect(env.BET_MIN_STAKE).toBe(10);
    expect(env.AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(false);
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv(apiEnvSchema, { ...base, API_PORT: '' });
    expect(env.API_PORT).toBe(4000);
  });

  it('refuses to start with real money enabled', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, REAL_MONEY_ENABLED: 'true' })).toThrow(
      /REAL_MONEY_ENABLED/,
    );
    expect(() => parseEnv(workerEnvSchema, { ...base, REAL_MONEY_ENABLED: '1' })).toThrow(EnvError);
  });

  it('rejects short secrets', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('caps configurable limits at the hard limits', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, BET_MAX_SELECTIONS: '50' })).toThrow(EnvError);
  });

  it('requires https in production for public hosts', () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...base, NODE_ENV: 'production', APP_URL: 'http://bet.example' }),
    ).toThrow(/https/);
    expect(
      parseEnv(apiEnvSchema, { ...base, NODE_ENV: 'production', APP_URL: 'http://localhost:3000' })
        .APP_URL,
    ).toBe('http://localhost:3000');
  });
});
