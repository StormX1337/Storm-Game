'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { Card, ScrollArea, cn } from '@storm/ui';
import { ADMIN_TABS, SERVER_TABS_NAV_CLASS } from '@/components/panel/sidebar';
import { useAuth } from '@/lib/auth-context';

/**
 * The administration area, with its sections as tabs rather than as eleven
 * sidebar entries.
 *
 * They were longer than the content beside them, and every one is somewhere an
 * operator goes occasionally rather than constantly — so they read better here,
 * where a server's sections already live, and the sidebar keeps to the three
 * places people actually move between.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading, can } = useAuth();
  const pathname = usePathname();

  if (loading) return null;

  // The API enforces this too; the guard here just avoids rendering an admin
  // shell that would fail every request inside it.
  if (!isAdmin) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <ShieldAlert className="h-5 w-5 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold">Administrator access required</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your account does not have permission to view the administration area.
        </p>
      </Card>
    );
  }

  // Same gate the sidebar applied, so an account that could reach only the
  // audit log still reaches only that.
  const visible = ADMIN_TABS.filter((tab) => can(tab.permission));

  return (
    <div className="mx-auto max-w-7xl animate-fade-in space-y-6">
      <ScrollArea className="w-full border-b border-border">
        <nav className={SERVER_TABS_NAV_CLASS} aria-label="Administration sections">
          {visible.map((tab) => {
            const href = tab.segment ? `/admin/${tab.segment}` : '/admin';
            const active = tab.segment ? pathname.startsWith(href) : pathname === '/admin';
            return (
              <Link
                key={tab.segment || 'overview'}
                href={href}
                className={cn(
                  'relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
                {active ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                ) : null}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>

      {children}
    </div>
  );
}
