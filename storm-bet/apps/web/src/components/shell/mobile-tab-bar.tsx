'use client';

import { cn } from '@storm-bet/ui';
import { Dices, Radio, Receipt, Trophy, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/sports', label: 'Sport', icon: Trophy, match: ['/sports', '/events'] },
  { href: '/live', label: 'Live', icon: Radio, match: ['/live'] },
  { href: '/casino', label: 'Casino', icon: Dices, match: ['/casino'] },
  { href: '/dashboard/bets', label: 'Wetten', icon: Receipt, match: ['/dashboard/bets'] },
  { href: '/dashboard', label: 'Konto', icon: UserRound, match: ['/dashboard', '/promotions'] },
];

/** Phone navigation; the header links take over from the md breakpoint. */
export function MobileTabBar() {
  const pathname = usePathname();
  const active = (tab: (typeof TABS)[number]) =>
    tab.href === '/dashboard'
      ? pathname === '/dashboard' ||
        (pathname.startsWith('/dashboard/') && !pathname.startsWith('/dashboard/bets')) ||
        pathname.startsWith('/promotions')
      : tab.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
  return (
    <>
      {/* Keeps the page end (footer) clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[calc(3.5rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        aria-label="Schnellnavigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="grid h-14 grid-cols-5">
          {TABS.map((tab) => {
            const on = active(tab);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                  on ? 'text-accent-strong' : 'text-fg-muted',
                )}
              >
                <tab.icon className="size-5" aria-hidden="true" />
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
