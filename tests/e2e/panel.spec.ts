import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ANONYMOUS } from './fixtures';

/**
 * These walk the paths a real customer takes: register, sign in, look at the
 * dashboard, open a server, read its console, browse its files. They assert
 * against what the browser actually renders, so a broken API contract or a
 * crashed client component fails the run.
 *
 * The administrator session comes from `auth.setup.ts` and is shared, because
 * the panel rate-limits authentication on purpose. Tests that need to be
 * anonymous say so.
 */

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function signIn(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
}

async function signOut(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /account menu/i })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
}

/**
 * The server list renders from a client-side query, so wait for it to settle
 * before deciding whether this environment has any servers at all.
 */
async function firstServerLink(page: Page): Promise<Locator | null> {
  const links = page.locator('a[href^="/servers/"]:not([href="/servers/new"])');
  const empty = page.getByText(/No servers yet|No matching servers/i);

  await expect(links.first().or(empty.first())).toBeVisible({ timeout: 25_000 });
  return (await links.count()) > 0 ? links.first() : null;
}

/** The tab strip on a server page, which repeats link names used elsewhere. */
function serverTab(page: Page, name: string): Locator {
  return page.getByLabel('Server sections').getByRole('link', { name });
}

test.describe('authentication', () => {
  test.use({ storageState: ANONYMOUS });

  test('shows the sign-in page', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email or username')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create one' })).toBeVisible();
  });

  test('rejects bad credentials with a readable message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email or username').fill('nobody@storm.test');
    await page.getByLabel('Password', { exact: true }).fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the form's own alert: Next.js injects a route announcer that
    // also carries role="alert".
    await expect(page.locator('form').getByRole('alert')).toContainText(/do not match/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('validates the registration form field by field', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Email', { exact: true }).fill('not-an-email');
    await page.getByLabel('Username').fill('x');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Every bad field is marked, not just the first one.
    await expect(page.getByText('Invalid email')).toBeVisible();
    await expect(page.getByText(/at least 3 character/i)).toBeVisible();
    await expect(page.getByText(/at least 10 characters/i)).toBeVisible();
  });

  test('registers a new customer and lands on the dashboard', async ({ page }) => {
    const suffix = unique();

    await page.goto('/register');
    await page.getByLabel('Email', { exact: true }).fill(`e2e-${suffix}@storm.test`);
    await page.getByLabel('Username').fill(`e2e${suffix}`);
    await page.getByLabel('Password', { exact: true }).fill('E2ePassword123!');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Registration is deliberately rate limited to five in ten minutes, so
    // running this suite twice in a row hits the limit rather than a bug. Say
    // that plainly: the alternative is a timeout on the line below, which
    // reads like the panel is broken and sends the next person hunting.
    const limited = page.getByText(/too many|rate limit/i);
    if (
      await limited
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
    ) {
      test.skip(
        true,
        'the registration rate limit is doing its job — wait ten minutes, or run against a fresh stack',
      );
    }

    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
    await expect(page.getByText('Total servers')).toBeVisible();

    // A customer sees no administration, and cannot reach it by URL either.
    await expect(page.getByText('ADMINISTRATION')).toBeHidden();
    await page.goto('/admin/users');
    await expect(page.getByText(/Administrator access required/i)).toBeVisible({ timeout: 20_000 });
  });

  test('redirects an anonymous visitor to sign in', async ({ page }) => {
    await page.goto('/servers');
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('signs out and blocks the panel afterwards', async ({ page }) => {
    // Its own session: signing out of the shared one would strand every test
    // that runs after this.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await signOut(page);

    await page.goto('/dashboard');
    await page.waitForURL(/\/login/, { timeout: 30_000 });
  });
});

test.describe('panel', () => {
  test('dashboard shows live figures', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('Total servers')).toBeVisible();
    // The stat tile's label, not a server's status badge — both say "Online".
    await expect(page.locator('p').filter({ hasText: /^Online$/ })).toBeVisible();
    await expect(page.getByText('Allocated resources')).toBeVisible();

    // The realtime socket should connect within a few seconds.
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test('server list filters and switches views', async ({ page }) => {
    await page.goto('/servers');
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();

    await page.getByLabel('Table view').click();
    await expect(page.getByRole('columnheader', { name: 'Server' })).toBeVisible();

    await page.getByLabel('Search servers').fill('definitely-no-such-server');
    await expect(page.getByText(/No matching servers/i)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText(/No matching servers/i)).toBeHidden();
  });

  test('creation wizard walks through its steps', async ({ page }) => {
    await page.goto('/servers/new');
    await expect(page.getByRole('heading', { name: 'Create a server' })).toBeVisible();

    // Cannot advance until a game is chosen.
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await expect(continueButton).toBeDisabled();

    await page.getByRole('button', { name: /Minecraft: Java Edition/ }).click();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    // Step two lists every eligible node with its real free capacity.
    await expect(page.getByText(/Free memory/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('opens a server and reads its console', async ({ page }) => {
    await page.goto('/servers');

    // The list is fetched client-side; counting before it settles would skip
    // the test on a stack that does have servers.
    const firstServer = await firstServerLink(page);
    test.skip(firstServer === null, 'no servers exist in this environment');

    await firstServer!.click();
    await page.waitForURL(/\/servers\/[^/]+$/, { timeout: 30_000 });

    await expect(serverTab(page, 'Console')).toBeVisible();
    await expect(page.getByText('CPU', { exact: true }).first()).toBeVisible();

    await serverTab(page, 'Console').click();
    await page.waitForURL(/\/console$/, { timeout: 30_000 });

    // The console websocket must connect and report its state.
    await expect(page.getByText(/Connected|Connecting/)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('opens the SFTP and team tabs', async ({ page }) => {
    await page.goto('/servers');

    const firstServer = await firstServerLink(page);
    test.skip(firstServer === null, 'no servers exist in this environment');

    await firstServer!.click();
    await page.waitForURL(/\/servers\/[^/]+$/, { timeout: 30_000 });

    await serverTab(page, 'SFTP').click();
    await page.waitForURL(/\/sftp$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'SFTP access' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Rotate password' })).toBeVisible();

    await serverTab(page, 'Team').click();
    await page.waitForURL(/\/subusers$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Shared access' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
  });

  test('browses server files', async ({ page }) => {
    await page.goto('/servers');

    const firstServer = await firstServerLink(page);
    test.skip(firstServer === null, 'no servers exist in this environment');

    await firstServer!.click();
    await page.waitForURL(/\/servers\/[^/]+$/, { timeout: 30_000 });
    await serverTab(page, 'Files').click();
    await page.waitForURL(/\/files$/, { timeout: 30_000 });

    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    // Either a listing or an explicit empty state — never a crash.
    await expect(
      page
        .getByRole('columnheader', { name: 'Name' })
        .or(page.getByText(/This folder is empty|No files match/)),
    ).toBeVisible({ timeout: 25_000 });
  });

  test('account security page exposes the security controls', async ({ page }) => {
    await page.goto('/account/security');

    await expect(page.getByRole('heading', { name: 'Password' })).toBeVisible();
    await expect(page.getByText('Two-factor authentication').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  });

  test('theme toggle switches between dark and light', async ({ page }) => {
    await page.goto('/dashboard');
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);

    await page.getByRole('button', { name: 'Toggle colour theme' }).click();
    await expect(html).toHaveClass(/light/);

    await page.getByRole('button', { name: 'Toggle colour theme' }).click();
    await expect(html).toHaveClass(/dark/);
  });
});

test.describe('administration', () => {
  test('every admin section renders', async ({ page }) => {
    const sections: [string, RegExp][] = [
      ['/admin', /Administration/],
      ['/admin/users', /Users/],
      ['/admin/nodes', /Nodes/],
      ['/admin/servers', /All servers/],
      ['/admin/templates', /Game templates/],
      ['/admin/audit', /Audit log/],
      ['/admin/databases', /Database hosts/],
      ['/admin/backups', /Backup storage/],
      ['/admin/settings', /Settings/],
      ['/admin/webhooks', /Webhooks/],
      ['/admin/updates', /Updates/],
    ];

    for (const [path, heading] of sections) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
        timeout: 20_000,
      });
    }
  });

  test('game templates are seeded and grouped', async ({ page }) => {
    await page.goto('/admin/templates');

    // A template's name appears both in its card heading and in its slug line,
    // so match the first occurrence rather than demanding a unique one.
    await expect(page.getByText('Minecraft: Java Edition').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Counter-Strike 2').first()).toBeVisible();
    await expect(page.getByText('Valheim').first()).toBeVisible();
  });

  test('audit log records recent actions', async ({ page }) => {
    await page.goto('/admin/audit');

    await expect(page.getByRole('columnheader', { name: 'Action' })).toBeVisible({
      timeout: 20_000,
    });
    // Signing in for this run must be recorded.
    await expect(page.getByText('Login').first()).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * The settings that reach the browser, and the admin controls on a server.
 *
 * These exist for a failure mode the unit tests structurally cannot catch: a
 * component that renders perfectly against a mocked payload of the wrong
 * shape. That shipped once here — a card asked a paginated endpoint for
 * `.items`, which paginated endpoints do not return, and the unit test agreed
 * because the same wrong shape was written into its mock. It looked fine until
 * a browser loaded it and the card offered nothing at all.
 *
 * So each of these drives the real API and asserts on real values coming back.
 */
test.describe('panel settings reach the browser', () => {
  // These are panel-wide rows, so every test here puts back what it changed.
  const RESTORE = {
    panelName: 'Storm Panel',
    announcement: '',
    announcementLevel: 'info',
    brandColor: '#2563eb',
  };

  test.afterEach(async ({ request }) => {
    await request.patch('/api/v1/admin/settings', { data: RESTORE });
  });

  test('renaming the panel renames it everywhere', async ({ page, request }) => {
    const name = `Panel ${unique()}`;
    const response = await request.patch('/api/v1/admin/settings', { data: { panelName: name } });
    expect(response.status()).toBe(200);

    await page.goto('/dashboard');
    // The sidebar reads the public settings endpoint, so seeing the new name
    // proves that whole chain: write, read without a session, provider, brand.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 25_000 });
  });

  test('an announcement appears, and stays dismissed', async ({ page, request }) => {
    const message = `Scheduled maintenance ${unique()}`;
    await request.patch('/api/v1/admin/settings', {
      data: { announcement: message, announcementLevel: 'warning' },
    });

    await page.goto('/dashboard');
    await expect(page.getByText(message)).toBeVisible({ timeout: 25_000 });

    await page.getByRole('button', { name: /dismiss announcement/i }).click();
    await expect(page.getByText(message)).toBeHidden();

    // Dismissal is remembered per message, so a reload must not bring it back.
    await page.reload();
    await expect(page.getByText(message)).toBeHidden({ timeout: 20_000 });
  });

  test('serves branding without a session, and nothing else', async ({ request }) => {
    const response = await request.get('/api/v1/settings');
    expect(response.status()).toBe(200);

    const settings = (await response.json()).data;
    expect(typeof settings.panelName).toBe('string');
    expect(typeof settings.brandColor).toBe('string');
    // How the panel is run stays behind the admin API.
    expect(settings).not.toHaveProperty('defaultMemoryLimit');
    expect(settings).not.toHaveProperty('backupRetentionDays');
  });
});

test.describe('server administration', () => {
  test('the limits card is filled from the server, not from a default', async ({ page }) => {
    await page.goto('/servers');
    const link = await firstServerLink(page);
    test.skip(link === null, 'this environment has no servers to administer');

    await link!.click();
    await page.waitForURL(/\/servers\/[^/]+/, { timeout: 25_000 });
    await serverTab(page, 'Settings').click();

    await expect(page.getByText('Resource limits')).toBeVisible({ timeout: 25_000 });

    // A number, and the server's own — a card rendering zeros would mean the
    // payload never reached it.
    const memory = page.getByLabel('Memory', { exact: true });
    await expect(memory).toBeVisible();
    expect(Number(await memory.inputValue())).toBeGreaterThan(0);
    expect(Number(await page.getByLabel('Disk', { exact: true }).inputValue())).toBeGreaterThan(0);
  });

  test('the move card lists the nodes the API actually returns', async ({ page, request }) => {
    // The regression test for a bug that shipped: the card read a paginated
    // endpoint as if it returned `{ items }`, so its list was always empty. No
    // mock catches that — the unit test had the same wrong shape written into
    // it. Only a browser talking to the real API does.
    //
    // It needs a node that is online and is not the one the server already
    // runs on, and hoping the environment has one is how this test passes
    // while proving nothing. So it makes one: register it, mint its token, and
    // send the heartbeat that a real agent would. That is the only thing which
    // turns a node ONLINE, and it is all public API.
    const suffix = unique();
    const created = await request.post('/api/v1/admin/nodes', {
      data: {
        name: `e2e-move-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '10.99.0.1',
        scheme: 'http',
        cpuCores: 4,
        memoryTotal: 32768,
        diskTotal: 204800,
      },
    });
    expect(created.status()).toBe(201);
    // Registering a node mints its first credentials in the same response —
    // that is how the installer gets them — so no second call is needed.
    const { node, token } = (await created.json()).data;

    try {
      const beat = await request.post('/api/v1/internal/heartbeat', {
        headers: { authorization: `Bearer ${token.tokenId}.${token.token}` },
        data: { agentVersion: '1.0.0', system: { dockerVersion: '27.0.0' } },
      });
      expect(beat.status(), 'the heartbeat is what makes a node ONLINE').toBe(200);

      await page.goto('/servers');
      const link = await firstServerLink(page);
      test.skip(link === null, 'this environment has no servers to administer');

      await link!.click();
      await page.waitForURL(/\/servers\/[^/]+/, { timeout: 25_000 });
      await serverTab(page, 'Settings').click();
      await expect(page.getByText('Move to another node')).toBeVisible({ timeout: 25_000 });

      // The node just brought online has to be offered. An empty chooser here
      // is exactly the shipped bug.
      await page.getByRole('combobox').last().click();
      await expect(
        page.getByRole('option', { name: new RegExp(`e2e-move-${suffix}`) }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await request.delete(`/api/v1/admin/nodes/${node.id}`);
    }
  });
});
