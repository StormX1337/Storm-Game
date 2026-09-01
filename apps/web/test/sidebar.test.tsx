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
    expect(screen.queryByRole('link', { name: /Administration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Audit log/ })).not.toBeInTheDocument();
  });

  it('offers an owner the administration area, as one entry', () => {
    // It used to list all eleven sections here. They are tabs on /admin now —
    // the strip was longer than the content beside it — so what the sidebar
    // owes is a way in, and admin-tabs.test.tsx owns the rest.
    renderAs(ALL_PERMISSIONS, true);

    expect(screen.getByRole('link', { name: /Administration/ })).toHaveAttribute('href', '/admin');
  });

  it('does not put the sections back in the sidebar', () => {
    // Listing them in both places is the state this move was meant to leave.
    renderAs(ALL_PERMISSIONS, true);

    for (const label of ['Backup storage', 'Database hosts', 'Game templates', 'Audit log']) {
      expect(
        screen.queryByRole('link', { name: new RegExp(label) }),
        `"${label}" belongs on the admin page now`,
      ).not.toBeInTheDocument();
    }
  });

  it('keeps the area out of reach of an account that cannot use it', () => {
    // Admin, but holding nothing that reaches the overview: no way in at all,
    // rather than a link to a page that refuses them.
    renderAs(['audit.view'], true);
    expect(screen.queryByRole('link', { name: /Administration/ })).not.toBeInTheDocument();
  });
});
