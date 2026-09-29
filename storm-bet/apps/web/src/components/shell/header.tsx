'use client';

import { cn } from '@storm-bet/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiveDot } from '../sportsbook/live-indicator';
import { Brand } from './brand';
import { UserMenu } from './user-menu';

const NAV = [
  { href: '/sports', label: 'Sport' },
  { href: '/live', label: 'Live', live: true },
  { href: '/casino', label: 'Casino' },
  { href: '/promotions', label: 'Aktionen' },
  { href: '/dashboard/bets', label: 'Meine Wetten' },
  { href: '/dashboard/wallet', label: 'Wallet' },
  { href: '/dashboard/profile', label: 'Profil' },
];

export function Header({ liveCount }: { liveCount?: number }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-4 sm:gap-4 lg:px-6">
        <Brand />
        {/* Phones use the bottom tab bar instead. */}
        <nav aria-label="Hauptnavigation" className="hidden items-center gap-1 md:flex">
          {NAV.map((item, i) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:px-2.5',
                  active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
                  i > 3 && 'hidden xl:flex',
                )}
              >
                {item.live ? <LiveDot /> : null}
                {item.label}
                {item.live && liveCount ? (
                  <span className="tabular text-xs text-fg-subtle">{liveCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
