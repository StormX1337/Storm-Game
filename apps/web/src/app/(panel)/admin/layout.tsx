'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { Card, ScrollArea, cn } from '@storm/ui';
import {
  ADMIN_GROUPS,
  ADMIN_GROUP_LABELS,
  ADMIN_TABS,
  SERVER_TABS_NAV_CLASS,
} from '@/components/panel/sidebar';
import { useAuth } from '@/lib/auth-context';

type AdminTab = (typeof ADMIN_TABS)[number];

/**
 * The administration area, with its sections beside the content rather than as
 * thirteen more entries in the sidebar.
 *
 * They were longer than the sidebar's own list and every one is somewhere an
 * operator goes occasionally rather than constantly, so they live with the
 * pages they open.
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

  // Built from what survived that gate, not from the full list: a group whose
  // every entry was filtered away must not leave its heading behind.
  const groups: { key: string; label: string | null; items: AdminTab[] }[] = [
    { key: 'top', label: null, items: visible.filter((tab) => tab.group === null) },
    ...ADMIN_GROUPS.map((group) => ({
      key: group,
      label: ADMIN_GROUP_LABELS[group],
      items: visible.filter((tab) => tab.group === group),
    })),
  ].filter((group) => group.items.length > 0);

  const linkFor = (tab: AdminTab): string => (tab.segment ? `/admin/${tab.segment}` : '/admin');
  const isCurrent = (tab: AdminTab): boolean =>
    tab.segment ? pathname.startsWith(linkFor(tab)) : pathname === '/admin';

  return (
    <div className="mx-auto max-w-7xl animate-fade-in">
      {/*
        One navigation, laid out two ways — the same bargain the server
        sections make, for the same reason.

        Wide enough and it is a rail down the left, grouped and headed, in the
        sidebar's own vocabulary: this is a second-level sidebar, so it should
        not invent a third idiom to be one. Thirteen sections in a row wrapped
        into two ragged lines at 1440px, which is the width most people have.

        Narrow and it falls back to the wrapped row. Held on one line the tabs
        scroll sideways with nothing on screen to say so, and the ones past the
        edge are simply unfindable; wrapping has no width at which anything is
        hidden.

        Two navigations would have been easier to write and wrong: both sit in
        the document whatever the width, so the page would carry the same
        landmark twice and a test would not know which it had found.
      */}
      {/* Stretched rather than start-aligned: the rule between rail and content
          is the edge of the navigation column, and a rule that stops two
          thirds of the way down the page reads as a rule that broke. */}
      <div className="lg:flex lg:gap-6">
        <ScrollArea className="w-full border-b border-border lg:w-auto lg:shrink-0 lg:border-b-0 lg:border-r">
          <nav
            className={cn(SERVER_TABS_NAV_CLASS, 'lg:w-52 lg:flex-col lg:gap-6 lg:pb-0 lg:pr-3')}
            aria-label="Administration sections"
          >
            {groups.map((group) => (
              // `contents` on a phone: the groups are a desktop idea, and the
              // wrapped row wants all thirteen as siblings so they fill each
              // line rather than breaking at every heading.
              <div key={group.key} className="contents lg:block lg:space-y-1">
                {group.label ? (
                  <p className="hidden px-3 pb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground lg:block">
                    {group.label}
                  </p>
                ) : null}
                {group.items.map((tab) => {
                  const active = isCurrent(tab);
                  return (
                    <Link
                      key={tab.segment || 'overview'}
                      href={linkFor(tab)}
                      className={cn(
                        'relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors',
                        'lg:gap-3 lg:rounded-lg lg:py-2 lg:transition-[background-color,color,box-shadow] lg:duration-150',
                        active
                          ? 'text-foreground lg:bg-primary/12 lg:text-primary lg:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]'
                          : 'text-muted-foreground hover:text-foreground lg:hover:bg-secondary/60',
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      {active ? (
                        <>
                          <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary lg:hidden" />
                          <span className="absolute left-0 top-1/2 hidden h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.7)] lg:block" />
                        </>
                      ) : null}
                      <tab.icon className="h-3.5 w-3.5 shrink-0 lg:h-4 lg:w-4" />
                      <span className="lg:truncate">{tab.label}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
        </ScrollArea>

        <div className="min-w-0 flex-1 space-y-6 pt-6 lg:pt-0">{children}</div>
      </div>
    </div>
  );
}
