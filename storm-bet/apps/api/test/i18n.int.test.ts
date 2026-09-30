import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('API language', () => {
  it('answers in English when the player chose English', async () => {
    const de = new Client(t.app);
    const wrongDe = await de.post('/api/auth/login', {
      email: 'x@y.de',
      password: 'irgendwas-123',
    });
    expect(wrongDe.body.error.message).toBe('E-Mail-Adresse oder Passwort ist falsch.');

    const en = new Client(t.app);
    en.setCookie('lang', 'en');
    const wrongEn = await en.post('/api/auth/login', {
      email: 'x@y.de',
      password: 'irgendwas-123',
    });
    expect(wrongEn.body.error.message).toBe('Email address or password is wrong.');
    const invalid = await en.post('/api/auth/login', { email: 'kaputt', password: '' });
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.values(invalid.body.error.details.fields as Record<string, string>)).toContain(
      'Please enter a valid email address',
    );
  });
});
