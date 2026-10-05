'use client';

import { cn } from '@storm-bet/ui';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiveDot } from '../sportsbook/live-indicator';
import { Brand } from './brand';
import { UserMenu } from './user-menu';
import { useT } from '@/i18n/client';

const NAV = [
  { href: '/sports', label: 'Sport', match: ['/sports', '/events'] },
  { href: '/live', label: 'Live', live: true },
  { href: '/promotions', label: 'Aktionen' },
  { href: '/bet-builder', label: 'Bet Builder' },
];

export function Header({ liveCount }: { liveCount?: number }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-[1760px] items-center gap-3 px-4 md:h-16 lg:gap-6 lg:px-6">
        <Brand />
        {/* Phones use the bottom navigation instead. */}
        <nav aria-label={t('Hauptnavigation')} className="hidden h-full items-stretch md:flex">
          {NAV.map((item) => {
            const active = (item.match ?? [item.href]).some(
              (m) => pathname === m || pathname.startsWith(`${m}/`),
            );
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-1.5 whitespace-nowrap px-3 text-sm font-semibold transition-colors lg:px-4 lg:text-[15px]',
                  active ? 'text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {item.live ? <LiveDot /> : null}
                {t(item.label)}
                {item.live && liveCount ? (
                  <span className="tabular rounded-full bg-live-soft px-1.5 text-[11px] font-semibold text-live">
                    {liveCount}
                  </span>
                ) : null}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/search"
            aria-label={t('Suche')}
            className="grid size-9 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            data-testid="search-link"
          >
            <Search className="size-[18px]" aria-hidden="true" />
          </Link>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
