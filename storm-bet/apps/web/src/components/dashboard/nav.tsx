'use client';

import { cn } from '@storm-bet/ui';
import {
  ArrowLeftRight,
  Dices,
  Gauge,
  LayoutDashboard,
  Receipt,
  ShieldCheck,
  User,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';

const ITEMS = [
  { href: '/dashboard', label: 'Übersicht', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/wallet', label: 'Guthaben', icon: Wallet },
  { href: '/dashboard/bets', label: 'Meine Wetten', icon: Receipt },
  { href: '/casino/history', label: 'Casino-Verlauf', icon: Dices },
  { href: '/dashboard/transactions', label: 'Transaktionen', icon: ArrowLeftRight },
  { href: '/dashboard/profile', label: 'Profil', icon: User },
  { href: '/dashboard/security', label: 'Sicherheit', icon: ShieldCheck },
  { href: '/dashboard/limits', label: 'Limits', icon: Gauge },
];

export function DashboardNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('Konto')}
      className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0"
    >
      {ITEMS.map((item) => {
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
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}
