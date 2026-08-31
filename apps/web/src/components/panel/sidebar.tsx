'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  CalendarClock,
  Database,
  Download,
  FolderTree,
  Gauge,
  HardDrive,
  LayoutDashboard,
  Network,
  Package,
  Server,
  Settings,
  Shield,
  KeyRound,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import { cn, ScrollArea } from '@storm/ui';
import { StormLogo } from '@/components/brand';
import { useAuth } from '@/lib/auth-context';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Panel-wide permission required to see the entry. */
  permission?: string;
  exact?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
  adminOnly?: boolean;
}

const SECTIONS: NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true },
      { href: '/servers', label: 'Servers', icon: Server },
      { href: '/account/notifications', label: 'Activity', icon: Activity },
    ],
  },
  {
    title: 'Administration',
    adminOnly: true,
    items: [
      {
        href: '/admin',
        label: 'Overview',
        icon: Gauge,
        exact: true,
        permission: 'admin.dashboard',
      },
      { href: '/admin/servers', label: 'All servers', icon: Server, permission: 'admin.servers' },
      { href: '/admin/users', label: 'Users', icon: Users, permission: 'users.manage' },
      { href: '/admin/nodes', label: 'Nodes', icon: Network, permission: 'nodes.manage' },
      {
        href: '/admin/templates',
        label: 'Game templates',
        icon: Package,
        permission: 'templates.manage',
      },
      {
        href: '/admin/databases',
        label: 'Database hosts',
        icon: Database,
        permission: 'databasehosts.manage',
      },
      {
        href: '/admin/backups',
        label: 'Backup storage',
        icon: HardDrive,
        permission: 'backupstorage.manage',
      },
      { href: '/admin/audit', label: 'Audit log', icon: Shield, permission: 'audit.view' },
      { href: '/admin/webhooks', label: 'Webhooks', icon: Webhook, permission: 'webhooks.manage' },
      { href: '/admin/settings', label: 'Settings', icon: Settings, permission: 'settings.manage' },
      { href: '/admin/updates', label: 'Updates', icon: Download, permission: 'panel.update' },
    ],
  },
];

/** Server-scoped links, shown while a server is open. */
/**
 * How the server tab row lays out. Wrapping is what makes all twelve reachable:
 * held on one line they scroll sideways, and on a phone the four that fit end
 * flush at the screen edge, so the rest cannot be found. No breakpoint — they
 * sit on one line wherever they fit.
 */
export const SERVER_TABS_NAV_CLASS = 'flex flex-wrap gap-1 pb-px';

export const SERVER_TABS = [
  { segment: '', label: 'Overview', icon: Gauge },
  { segment: 'console', label: 'Console', icon: Activity },
  { segment: 'files', label: 'Files', icon: FolderTree },
  { segment: 'backups', label: 'Backups', icon: HardDrive },
  { segment: 'schedules', label: 'Schedules', icon: CalendarClock },
  { segment: 'databases', label: 'Databases', icon: Database },
  { segment: 'network', label: 'Network', icon: Network },
  { segment: 'sftp', label: 'SFTP', icon: KeyRound },
  { segment: 'subusers', label: 'Team', icon: Users },
  { segment: 'startup', label: 'Startup', icon: Package },
  { segment: 'activity', label: 'Activity', icon: Activity },
  { segment: 'settings', label: 'Settings', icon: Settings },
] as const;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { can, isAdmin } = useAuth();

  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <>
      {/* Scrim: only rendered on mobile, where the sidebar overlays content. */}
      {open ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-surface transition-transform duration-200 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5">
          <Link href="/dashboard" onClick={onClose}>
            <StormLogo />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ScrollArea className="flex-1">
          <nav className="space-y-6 p-3">
            {SECTIONS.map((section, index) => {
              if (section.adminOnly && !isAdmin) return null;

              const visible = section.items.filter(
                (item) => !item.permission || can(item.permission),
              );
              if (visible.length === 0) return null;

              return (
                <div key={section.title ?? index} className="space-y-1">
                  {section.title ? (
                    <p className="px-3 pb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {section.title}
                    </p>
                  ) : null}
                  {visible.map((item) => {
                    const active = isActive(item);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onClose}
                        className={cn(
                          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          active
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        )}
                        aria-current={active ? 'page' : undefined}
                      >
                        {active ? (
                          <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
                        ) : null}
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </ScrollArea>

        <div className="shrink-0 border-t border-border p-3">
          <Link
            href="/account"
            onClick={onClose}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              pathname.startsWith('/account')
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <Settings className="h-4 w-4" />
            Account settings
          </Link>
        </div>
      </aside>
    </>
  );
}
