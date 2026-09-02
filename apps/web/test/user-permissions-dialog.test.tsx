import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@storm/ui';
import { Permission } from '@storm/types';

/**
 * Granting one account more than its role, or less.
 *
 * The dialog reads three endpoints and each answers a different shape. The
 * first version typed the account endpoint as the bare account, which compiled
 * — a type assertion is a claim, not a check — and crashed the dialog the
 * moment it opened, because that endpoint wraps the account alongside its
 * servers and sessions.
 *
 * So the stub answers the envelopes the API really sends. Flatten any of them
 * and these fail, which is the whole reason they are written this way.
 */

const state = vi.hoisted(() => ({
  /** Exactly what GET /admin/users/:id returns: an envelope, not the account. */
  detail: {
    user: {
      id: 'usr_1',
      username: 'anna',
      role: 'CUSTOMER',
      permissions: ['servers.view', 'servers.create'],
      extraPermissions: ['audit.view'],
      deniedPermissions: ['servers.create'],
    },
    servers: [],
    sessions: [],
  },
  saved: null as unknown,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/admin/users/')) return state.detail;
        if (path === '/admin/roles')
          return [
            {
              name: 'CUSTOMER',
              displayName: 'Customer',
              permissions: ['servers.view', 'servers.create'],
            },
          ];
        if (path === '/admin/roles/permissions')
          return [
            { key: 'servers.view', category: 'server', description: 'View servers' },
            { key: 'servers.create', category: 'server', description: 'Create servers' },
            { key: 'audit.view', category: 'admin', description: 'Read the audit log' },
          ];
        throw new Error(`unexpected path ${path}`);
      }),
      patch: vi.fn(async (_path: string, body: unknown) => {
        state.saved = body;
        return {};
      }),
    },
  };
});

const { UserPermissionsDialog } = await import('@/components/panel/user-permissions-dialog');
const { api } = await import('@/lib/api');

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UserPermissionsDialog userId="usr_1" username="anna" onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('UserPermissionsDialog', () => {
  beforeEach(() => {
    state.saved = null;
  });

  it('opens against the envelope the API actually sends', async () => {
    open();
    // Reaching the permission rows at all means the account was found inside
    // its envelope; the flattened version threw before rendering anything.
    expect(await screen.findByText('servers.view')).toBeInTheDocument();
    expect(screen.getByText('audit.view')).toBeInTheDocument();
  });

  it('shows what is already overridden rather than starting blank', async () => {
    open();
    await screen.findByText('servers.view');
    // One grant and one deny were loaded from the account.
    expect(screen.getByText('2 overrides')).toBeInTheDocument();
  });

  it('separates "the role never gave it" from "somebody took it away"', async () => {
    open();
    await screen.findByText('servers.create');

    // servers.create is in the role and denied, so it reads as blocked;
    // audit.view is not in the role and granted, so it reads as allowed.
    // Two checkboxes could not tell these apart.
    const denied = screen.getByLabelText('Deny servers.create');
    const granted = screen.getByLabelText('Grant audit.view');
    expect(denied).toHaveAttribute('aria-pressed', 'true');
    expect(granted).toHaveAttribute('aria-pressed', 'true');

    const roleDefault = screen.getByLabelText('Role servers.view');
    expect(roleDefault).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends both lists, and sends them separately', async () => {
    open();
    await screen.findByText('servers.view');

    await userEvent.click(screen.getByLabelText('Deny servers.view'));
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }));

    await waitFor(() => expect(state.saved).not.toBeNull());
    expect(state.saved).toEqual({
      extraPermissions: [Permission.AUDIT_VIEW],
      deniedPermissions: [Permission.SERVERS_CREATE, Permission.SERVERS_VIEW],
    });
    expect(api.patch).toHaveBeenCalledWith('/admin/users/usr_1', expect.anything());
  });
});
