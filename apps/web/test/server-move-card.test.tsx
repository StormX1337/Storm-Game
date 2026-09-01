import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider, ToastProvider } from '@storm/ui';
import { Permission } from '@storm/types';

const auth = vi.hoisted(() => ({ permissions: [] as string[], role: 'CUSTOMER' }));
const ctx = vi.hoisted(() => ({ status: 'OFFLINE' }));
const nodes = vi.hoisted(() => ({
  items: [
    {
      id: 'node_current',
      name: 'Frankfurt',
      location: 'DE',
      status: 'ONLINE',
      maintenanceMode: false,
      memoryTotal: 8192,
      allocatedMemory: 1024,
    },
    {
      id: 'node_other',
      name: 'Helsinki',
      location: 'FI',
      status: 'ONLINE',
      maintenanceMode: false,
      memoryTotal: 8192,
      allocatedMemory: 0,
    },
    {
      id: 'node_down',
      name: 'Warsaw',
      location: 'PL',
      status: 'OFFLINE',
      maintenanceMode: false,
      memoryTotal: 8192,
      allocatedMemory: 0,
    },
    {
      id: 'node_maint',
      name: 'Paris',
      location: 'FR',
      status: 'ONLINE',
      maintenanceMode: true,
      memoryTotal: 8192,
      allocatedMemory: 0,
    },
  ],
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    can: (...required: string[]) =>
      auth.role === 'OWNER' || required.some((p) => auth.permissions.includes(p)),
    isAdmin: true,
    user: null,
  }),
}));

vi.mock('@/components/panel/server-context', () => ({
  useServer: () => ({
    server: { id: 'srv_1', shortId: 'abc123', node: { id: 'node_current', name: 'Frankfurt' } },
    status: ctx.status,
  }),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
    // The shape apiPaginated really returns. Mocking `api.get` with an
    // `{ items }` envelope is what hid a card that offered no nodes at all.
    apiPaginated: vi.fn(async () => ({
      items: nodes.items,
      meta: { page: 1, perPage: 100, total: nodes.items.length, totalPages: 1 },
    })),
  };
});

const { ServerMoveCard } = await import('@/components/panel/server-move-card');

function renderAs(role: string, permissions: string[]) {
  auth.role = role;
  auth.permissions = permissions;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <ServerMoveCard />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ServerMoveCard', () => {
  it('offers the move to an administrator', async () => {
    renderAs('ADMIN', [Permission.ADMIN_SERVERS]);
    expect(await screen.findByText('Move to another node')).toBeInTheDocument();
  });

  it("hides it from a server's own owner", () => {
    // The endpoint refuses them, so offering the form would be a button that
    // only ever produces an error.
    renderAs('CUSTOMER', ['servers.update']);
    expect(screen.queryByText('Move to another node')).not.toBeInTheDocument();
  });

  it('hides it from admin.dashboard alone, which the endpoint does not accept', () => {
    renderAs('SUPPORT', ['admin.dashboard']);
    expect(screen.queryByText('Move to another node')).not.toBeInTheDocument();
  });

  it('reads the node list through the paginated helper', async () => {
    // The bug this pins down shipped: `/admin/nodes` is paginated and answers
    // with the array as `data`, so `api.get(...).items` is always undefined and
    // the card silently offers nothing. Asserting the returned shape cannot
    // catch it — the mock would just carry the same wrong assumption — so this
    // asserts which helper was called instead.
    const { api, apiPaginated } = await import('@/lib/api');
    vi.mocked(api.get).mockClear();
    vi.mocked(apiPaginated).mockClear();

    renderAs('OWNER', []);
    await screen.findByText('Move to another node');

    expect(apiPaginated).toHaveBeenCalledWith('/admin/nodes', expect.anything());
    expect(api.get).not.toHaveBeenCalledWith('/admin/nodes', expect.anything());
  });

  it('never offers a node the move would be refused for', async () => {
    // The current node, one in maintenance and one offline are all rejected by
    // the preflight. Listing them would send an administrator to a 409.
    renderAs('OWNER', []);
    await screen.findByText('Move to another node');

    const trigger = screen.getByRole('combobox');
    trigger.click();

    const options = await screen.findAllByRole('option').catch(() => []);
    const labels = options.map((option) => option.textContent ?? '');
    expect(labels.join(' ')).toContain('Helsinki');
    expect(labels.join(' ')).not.toContain('Frankfurt');
    expect(labels.join(' ')).not.toContain('Warsaw');
    expect(labels.join(' ')).not.toContain('Paris');
  });
});
