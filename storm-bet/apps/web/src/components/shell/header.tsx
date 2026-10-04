'use client';

import { cn } from '@storm-bet/ui';
import { Gift, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiveDot } from '../sportsbook/live-indicator';
import { Brand } from './brand';
import { UserMenu } from './user-menu';
import { useT } from '@/i18n/client';

const NAV = [
  { href: '/sports', label: 'Sport' },
  { href: '/live', label: 'Live', live: true },
  { href: '/casino', label: 'Casino' },
  { href: '/feed', label: 'Tipp-Feed' },
  { href: '/leaderboard', label: 'Rangliste' },
  { href: '/promotions', label: 'Aktionen' },
  { href: '/dashboard/bets', label: 'Meine Wetten' },
  { href: '/dashboard/wallet', label: 'Wallet' },
  { href: '/dashboard/profile', label: 'Profil' },
];

export function Header({ liveCount }: { liveCount?: number }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[linear-gradient(100deg,#2337c6,#4f6bff_55%,#6d8bff)] pt-[env(safe-area-inset-top)] md:border-border md:bg-bg/85 md:bg-none md:backdrop-blur md:supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-3 sm:gap-4 sm:px-4 lg:px-6">
        <Brand />
        {/* Phones use the bottom tab bar instead. */}
        <nav aria-label={t('Hauptnavigation')} className="hidden items-center gap-1 md:flex">
          {NAV.map((item, i) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:px-2.5',
                  active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
                  i > 5 && 'hidden xl:flex',
                )}
              >
                {item.live ? <LiveDot /> : null}
                {t(item.label)}
                {item.live && liveCount ? (
                  <span className="tabular text-xs text-fg-subtle">{liveCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          <Link
            href="/promotions"
            aria-label={t('Aktionen')}
            className="grid size-9 place-items-center rounded-full text-white/90 transition-colors hover:bg-white/10 md:text-fg-muted md:hover:bg-surface-3 md:hover:text-fg"
          >
            <Gift className="size-5" aria-hidden="true" />
          </Link>
          <Link
            href="/search"
            aria-label={t('Suche')}
            className="grid size-9 place-items-center rounded-full text-white/90 transition-colors hover:bg-white/10 md:text-fg-muted md:hover:bg-surface-3 md:hover:text-fg"
            data-testid="search-link"
          >
            <Search className="size-5" aria-hidden="true" />
          </Link>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
