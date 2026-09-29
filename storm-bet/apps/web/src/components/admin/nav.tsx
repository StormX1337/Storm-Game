'use client';

import { hasPermission, Permission, type UserRole } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import {
  Activity,
  ArrowLeftRight,
  CalendarDays,
  Gauge,
  Radio,
  Receipt,
  ScrollText,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  {
    href: '/admin',
    label: 'Übersicht',
    icon: Gauge,
    exact: true,
    permission: Permission.ADMIN_ACCESS,
  },
  { href: '/admin/users', label: 'Nutzer', icon: Users, permission: Permission.USERS_READ },
  {
    href: '/admin/events',
    label: 'Events & Märkte',
    icon: CalendarDays,
    permission: Permission.EVENTS_READ,
  },
  { href: '/admin/bets', label: 'Wetten', icon: Receipt, permission: Permission.BETS_READ },
  {
    href: '/admin/transactions',
    label: 'Transaktionen',
    icon: ArrowLeftRight,
    permission: Permission.TRANSACTIONS_READ,
  },
  { href: '/admin/audit', label: 'Audit-Log', icon: ScrollText, permission: Permission.AUDIT_READ },
  {
    href: '/admin/providers',
    label: 'Odds-Provider',
    icon: Radio,
    permission: Permission.PROVIDERS_READ,
  },
  { href: '/admin/system', label: 'System', icon: Activity, permission: Permission.SYSTEM_READ },
];

export function AdminNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Administration"
      className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0"
    >
      {ITEMS.filter((i) => hasPermission(role, i.permission)).map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <item.icon className="size-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
