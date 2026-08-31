import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ALL_PERMISSIONS, CUSTOMER_PERMISSIONS } from '@storm/types';

const auth = vi.hoisted(() => ({ permissions: [] as string[], isAdmin: false }));

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    can: (...required: string[]) => required.some((p) => auth.permissions.includes(p)),
    isAdmin: auth.isAdmin,
    user: null,
    refresh: vi.fn(),
  }),
}));

const { Sidebar } = await import('@/components/panel/sidebar');

function renderAs(permissions: readonly string[], isAdmin: boolean) {
  auth.permissions = [...permissions];
  auth.isAdmin = isAdmin;
  return render(<Sidebar open onClose={() => {}} />);
}

describe('Sidebar', () => {
  it('shows a customer their own servers and no administration', () => {
    renderAs(CUSTOMER_PERMISSIONS, false);

    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Servers/ })).toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Audit log/ })).not.toBeInTheDocument();
  });

  it('shows every administration entry to an owner', () => {
    // Each of these is gated on a permission string typed by hand. A typo
    // there hides the entry forever and nothing else would notice.
    renderAs(ALL_PERMISSIONS, true);

    expect(screen.getByText('Administration')).toBeInTheDocument();
    for (const label of [
      'Overview',
      'All servers',
      'Users',
      'Nodes',
      'Game templates',
      'Database hosts',
      'Backup storage',
      'Audit log',
      'Settings',
    ]) {
      expect(screen.getByRole('link', { name: new RegExp(label) }), `missing "${label}"`).toBeInTheDocument();
    }
  });

  it('hides the entries a staff account may not use', () => {
    // Admin, but only holding the audit permission: the audit log appears and
    // the rest of the section does not.
    renderAs(['audit.view'], true);

    expect(screen.getByRole('link', { name: /Audit log/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Backup storage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Database hosts/ })).not.toBeInTheDocument();
  });
});
