import path from 'node:path';

/**
 * The account these tests sign in as. The fallbacks are for a local stack you
 * seeded yourself with matching ADMIN_* values — no deployment ever creates
 * this account on its own, and nothing reads these outside the test run. Point
 * them somewhere else with STORM_ADMIN_EMAIL / STORM_ADMIN_PASSWORD.
 */
export const ADMIN_EMAIL = process.env.STORM_ADMIN_EMAIL ?? 'admin@storm.local';
export const ADMIN_PASSWORD = process.env.STORM_ADMIN_PASSWORD ?? 'StormAdmin123!';

/** Where the signed-in administrator session is cached between projects. */
export const ADMIN_STATE = path.join(__dirname, '.auth', 'admin.json');

/** Anonymous: no cookies, no origins. */
export const ANONYMOUS: { cookies: []; origins: [] } = { cookies: [], origins: [] };
