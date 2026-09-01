import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { parseEnv, EnvValidationError } from '../src/env.js';

/**
 * Reading configuration from the environment.
 *
 * The case that matters here came from following the install guide: several
 * keys in `.env.example` ship with nothing after the `=`, meant to be filled in
 * only if wanted, and Docker Compose passes those through as `""` rather than
 * leaving them unset. To zod an empty string is a value, so an optional field
 * with a format check rejected it — a fresh install died on boot with
 * "ADMIN_EMAIL: Invalid email" for a line the operator had deliberately left
 * blank.
 */
describe('parseEnv', () => {
  const schema = z.object({
    OPTIONAL_EMAIL: z.string().email().optional(),
    OPTIONAL_URL: z.string().url().optional(),
    OPTIONAL_PLAIN: z.string().optional(),
    WITH_DEFAULT: z.string().default('fallback'),
    REQUIRED_SECRET: z.string().min(32),
  });

  const valid = { REQUIRED_SECRET: 'x'.repeat(32) };

  it('treats a variable set to nothing as one that was never set', () => {
    const env = parseEnv(schema, { ...valid, OPTIONAL_EMAIL: '', OPTIONAL_URL: '' });
    assert.equal(env.OPTIONAL_EMAIL, undefined);
    assert.equal(env.OPTIONAL_URL, undefined);
  });

  it('lets a blank fall through to the default, rather than overriding it', () => {
    // An operator who clears a line means "use whatever you would have used",
    // not "use the empty string".
    const env = parseEnv(schema, { ...valid, WITH_DEFAULT: '' });
    assert.equal(env.WITH_DEFAULT, 'fallback');
  });

  it('still keeps a value that was actually given', () => {
    const env = parseEnv(schema, {
      ...valid,
      OPTIONAL_EMAIL: 'ops@example.com',
      WITH_DEFAULT: 'chosen',
    });
    assert.equal(env.OPTIONAL_EMAIL, 'ops@example.com');
    assert.equal(env.WITH_DEFAULT, 'chosen');
  });

  it('still refuses a required value left blank, and says it is missing', () => {
    // Blank must not become a way to skip something the panel cannot run
    // without — it only stops meaning "malformed".
    assert.throws(
      () => parseEnv(schema, { REQUIRED_SECRET: '' }),
      (error: unknown) => {
        assert.ok(error instanceof EnvValidationError);
        assert.match(error.message, /REQUIRED_SECRET/);
        assert.match(error.message, /required/i, 'a blank is missing, not badly formatted');
        return true;
      },
    );
  });

  it('still refuses a value that is present and wrong', () => {
    assert.throws(
      () => parseEnv(schema, { ...valid, OPTIONAL_EMAIL: 'not-an-email' }),
      /OPTIONAL_EMAIL/,
    );
  });

  it('names every bad field at once, not just the first', () => {
    // An operator fixing a .env should not have to restart four times to be
    // told about four problems.
    assert.throws(
      () => parseEnv(schema, { REQUIRED_SECRET: 'short', OPTIONAL_EMAIL: 'nope' }),
      (error: unknown) => {
        assert.ok(error instanceof EnvValidationError);
        assert.match(error.message, /REQUIRED_SECRET/);
        assert.match(error.message, /OPTIONAL_EMAIL/);
        return true;
      },
    );
  });
});
