import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@storm/ui';
import { Permission } from '@storm/types';

const auth = vi.hoisted(() => ({ permissions: [] as string[], role: 'CUSTOMER' }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    can: (...required: string[]) =>
      auth.role === 'OWNER' || required.some((p) => auth.permissions.includes(p)),
    isAdmin:
      auth.role === 'OWNER' ||
      auth.permissions.includes('admin.dashboard') ||
      auth.permissions.includes('admin.servers'),
    user: null,
  }),
}));

vi.mock('@/components/panel/server-context', () => ({
  useServer: () => ({
    server: {
      id: 'srv_1',
      shortId: 'abc123',
      limits: { cpuLimit: 200, memoryLimit: 1024, diskLimit: 10240, swapLimit: 0 },
    },
  }),
}));

const { ServerLimitsCard } = await import('@/components/panel/server-limits-card');

function renderAs(role: string, permissions: string[]) {
  auth.role = role;
  auth.permissions = permissions;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ServerLimitsCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ServerLimitsCard', () => {
  it('lets an administrator raise a memory limit', () => {
    renderAs('ADMIN', [Permission.ADMIN_SERVERS]);
    expect(screen.getByText('Resource limits')).toBeInTheDocument();
    // By its label, so this also proves the label actually names the input
    // rather than the wrapper the icon sits in.
    expect(screen.getByLabelText('Memory')).toHaveValue(1024);
    expect(screen.getByLabelText('CPU')).toHaveValue(200);
    expect(screen.getByLabelText('Disk')).toHaveValue(10240);
  });

  it('shows it to the panel owner, who holds everything implicitly', () => {
    renderAs('OWNER', []);
    expect(screen.getByText('Resource limits')).toBeInTheDocument();
  });

  it("hides it from a server's own owner, who must not move their own ceiling", () => {
    // The whole point of a limit is that the person it constrains cannot raise
    // it. The API refuses them, and offering the form anyway would be a button
    // that only ever produces an error.
    renderAs('CUSTOMER', ['servers.update']);
    expect(screen.queryByText('Resource limits')).not.toBeInTheDocument();
  });

  it('hides it from admin.dashboard alone, which the API does not accept', () => {
    // A permission set that reaches the admin area but not this endpoint. If
    // the card were gated on the looser "is an admin" idea instead of the
    // permission the API actually checks, this would render a form whose every
    // submission comes back 403.
    renderAs('SUPPORT', ['admin.dashboard']);
    expect(screen.queryByText('Resource limits')).not.toBeInTheDocument();
  });
});
