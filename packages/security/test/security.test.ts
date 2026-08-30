import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { hashPassword, verifyPassword, needsRehash } from '../src/password.js';
import { Encrypter } from '../src/crypto.js';
import { signRequest, verifySignature } from '../src/signature.js';
import {
  resolveSafePath,
  assertNoSymlinkEscape,
  sanitizeFilename,
  normalizeDisplayPath,
  PathTraversalError,
} from '../src/paths.js';
import { isPrivateAddress, assertSafeUrl } from '../src/ssrf.js';
import { buildTotpUri, generateTotp, generateTotpSecret, verifyTotp } from '../src/totp.js';
import { redact } from '../src/redact.js';
import { generateBackupCodes, hashToken, safeCompare } from '../src/tokens.js';

test('argon2 hashes verify and reject', async () => {
  const digest = await hashPassword('correct horse battery staple');
  assert.ok(digest.startsWith('$argon2id$'));
  assert.equal(await verifyPassword(digest, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(digest, 'wrong password'), false);
  assert.equal(await verifyPassword('not-a-hash', 'anything'), false);
  assert.equal(needsRehash(digest), false);
  assert.equal(needsRehash('$argon2i$v=19$m=4096,t=1,p=1$abc$def'), true);
});

test('encrypter round-trips and rejects tampering', () => {
  const enc = new Encrypter('a'.repeat(48));
  const cipher = enc.encrypt('super-secret-node-token');
  assert.notEqual(cipher, 'super-secret-node-token');
  assert.equal(enc.decrypt(cipher), 'super-secret-node-token');

  const tampered = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => enc.decrypt(tampered));
  assert.equal(enc.tryDecrypt(tampered), null);
  assert.throws(() => new Encrypter('short'));
});

test('request signatures bind method, path and time', () => {
  const secret = 'node-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const parts = { method: 'POST', path: '/api/v1/servers', timestamp, body: '{"a":1}' };
  const sig = signRequest(secret, parts);

  assert.equal(verifySignature(secret, parts, sig), true);
  assert.equal(verifySignature('other-secret', parts, sig), false);
  assert.equal(verifySignature(secret, { ...parts, method: 'DELETE' }, sig), false);
  assert.equal(verifySignature(secret, { ...parts, path: '/api/v1/nodes' }, sig), false);

  const stale = { ...parts, timestamp: String(Math.floor(Date.now() / 1000) - 4000) };
  assert.equal(verifySignature(secret, stale, signRequest(secret, stale)), false);
});

test('path resolution blocks traversal', () => {
  const root = '/var/lib/storm/servers/abc';
  assert.equal(resolveSafePath(root, '/plugins/config.yml'), `${root}/plugins/config.yml`);
  assert.equal(resolveSafePath(root, 'plugins/../logs'), `${root}/logs`);
  assert.equal(resolveSafePath(root, '/etc/passwd'), `${root}/etc/passwd`);

  assert.throws(() => resolveSafePath(root, '../../../etc/passwd'), PathTraversalError);
  assert.throws(() => resolveSafePath(root, '/../abcd/secret'), PathTraversalError);
  assert.throws(() => resolveSafePath(root, 'ok/\0/bad'), PathTraversalError);
  assert.throws(() => resolveSafePath(root, '..\\..\\windows'), PathTraversalError);
});

test('symlink escapes are rejected', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-sec-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.writeFile(path.join(root, 'ok.txt'), 'fine');

  await assertNoSymlinkEscape(root, path.join(root, 'ok.txt'));
  await assertNoSymlinkEscape(root, path.join(root, 'does-not-exist-yet.txt'));
  await assert.rejects(
    () => assertNoSymlinkEscape(root, path.join(root, 'escape', 'secret.txt')),
    PathTraversalError,
  );
  await fs.rm(base, { recursive: true, force: true });
});

test('filename sanitising and display paths', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..'), 'unnamed');
  assert.equal(sanitizeFilename('C:\\windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(normalizeDisplayPath('plugins//nested/'), '/plugins/nested');
  assert.equal(normalizeDisplayPath(''), '/');
});

test('SSRF guard blocks internal ranges', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data'));
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'));
  const url = await assertSafeUrl('http://10.0.0.5:8081/api/v1/system', { allowPrivate: true });
  assert.equal(url.port, '8081');
});

test('totp verification', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, '000000') && verifyTotp(secret, '111111'), false);
  assert.equal(verifyTotp(secret, 'abcdef'), false);
  assert.equal(verifyTotp('', '123456'), false);

  // The happy path matters most: a code from the enrolled secret is accepted,
  // and the same code against a different secret is not.
  assert.equal(verifyTotp(secret, generateTotp(secret)), true);
  assert.equal(verifyTotp(generateTotpSecret(), generateTotp(secret)), false);
});

test('totp enrolment uri carries what an authenticator needs', () => {
  // This string is what the setup QR encodes. If a field here is wrong, every
  // scan produces codes the panel will reject.
  const secret = generateTotpSecret();
  const uri = new URL(buildTotpUri(secret, 'player@example.com', 'Storm Panel'));

  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(decodeURIComponent(uri.pathname.slice(1)), 'Storm Panel:player@example.com');
  assert.equal(uri.searchParams.get('secret'), secret);
  assert.equal(uri.searchParams.get('issuer'), 'Storm Panel');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
});

test('redaction strips secrets', () => {
  const out = redact({ email: 'a@b.c', password: 'hunter2', nested: { apiKey: 'x', keep: 1 } });
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
  assert.equal(out.nested.keep, 1);
  assert.equal(out.email, 'a@b.c');
});

test('token helpers', () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('abd'));
  assert.equal(safeCompare('abc', 'abc'), true);
  assert.equal(safeCompare('abc', 'abd'), false);
  assert.equal(safeCompare('abc', 'abcd'), false);
  const codes = generateBackupCodes(5);
  assert.equal(codes.length, 5);
  assert.equal(new Set(codes).size, 5);
  assert.match(codes[0]!, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
});
