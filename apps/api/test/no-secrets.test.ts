import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Secrets do not belong in the source tree.
 *
 * This is a panel that holds node tokens, database passwords, SFTP passwords
 * and 2FA seeds for other people, so a credential committed here is not one
 * mistake — it is every deployment that ever pulls the repository. Reviews miss
 * these; a grep does not.
 */

const REPO = path.resolve(import.meta.dirname ?? '.', '../../..');

/** Every tracked file, so generated output and dependencies stay out of it. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function read(file: string): string {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

const SOURCE = /\.(ts|tsx|js|mjs|sh|yml|yaml|json)$/;

/** Files that talk about secrets for a living, and one that is all examples. */
const ALLOWED = [/^\.env\.example$/, /^docs\//, /(^|\/)test\//, /\.test\.(ts|tsx)$/, /^tests\//];

function filesToScan(): string[] {
  return trackedFiles().filter(
    (file) => SOURCE.test(file) && !ALLOWED.some((pattern) => pattern.test(file)),
  );
}

describe('no secrets in the source tree', () => {
  it('has no private key committed anywhere, including certificates', () => {
    for (const file of trackedFiles()) {
      const content = read(file);
      assert.doesNotMatch(
        content,
        /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
        `${file} contains a private key`,
      );
    }
  });

  it('never assigns a literal to a secret variable', () => {
    // Reading one from the environment is the point; writing one down is not.
    const assignment =
      /(JWT_SECRET|ENCRYPTION_KEY|COOKIE_SECRET|SMTP_PASSWORD|POSTGRES_PASSWORD|AGENT_SECRET|AGENT_TOKEN)\s*[:=]\s*['"][^'"$\s{}]{8,}['"]/;

    for (const file of filesToScan()) {
      const content = read(file);
      const match = assignment.exec(content);
      assert.equal(match, null, `${file} hardcodes a secret: ${match?.[0]}`);
    }
  });

  it('ships no default password for anything that runs in production', () => {
    // A default is worse than no value: it works, so nobody changes it.
    // Anchored on the closing quote: the value has to *be* the weak word, not
    // merely start with it. Without that, CACHE_KEY = 'storm:update:latest'
    // reads as a credential called storm.
    const defaulted =
      /(PASSWORD|SECRET|TOKEN|CREDENTIAL)\w*\s*[:=]\s*['"](changeme|password|secret|admin|storm|123456|letmein)['"]/i;

    for (const file of filesToScan()) {
      const content = read(file);
      const match = defaulted.exec(content);
      assert.equal(match, null, `${file} carries a default credential: ${match?.[0]}`);
    }
  });

  it('keeps the real .env out of git', () => {
    const tracked = trackedFiles();
    assert.equal(tracked.includes('.env'), false, '.env is committed');
    assert.ok(tracked.includes('.env.example'), 'the example is missing');
  });

  it('requires every secret rather than defaulting it', () => {
    // The config schema is where a default would silently become the value
    // every deployment runs with.
    const env = read('packages/config/src/env.ts');
    for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY', 'COOKIE_SECRET']) {
      const line = env.split('\n').find((row) => row.trim().startsWith(`${name}:`)) ?? '';
      assert.doesNotMatch(line, /\.default\(/, `${name} has a default in the config schema`);
    }
  });
});
