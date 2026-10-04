'use client';

import type { AccountSummaryDto } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { Dices, House, Radio, Receipt, Trophy } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useT } from '@/i18n/client';
import { useSession, WALLET_CHANGED } from '../providers/session';

const TABS = [
  { href: '/', label: 'Start', icon: House, match: [] as string[] },
  { href: '/sports', label: 'Sport', icon: Trophy, match: ['/sports', '/events'] },
  { href: '/casino', label: 'Casino', icon: Dices, match: ['/casino'], featured: true },
  { href: '/live', label: 'Live', icon: Radio, match: ['/live'] },
  { href: '/dashboard/bets', label: 'Wetten', icon: Receipt, match: ['/dashboard/bets'] },
];

/** Open bets for the badge; refreshed whenever the balance moves (bet placed or settled). */
function useOpenBets() {
  const { user } = useSession();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!user) {
      setCount(0);
      return;
    }
    let alive = true;
    const load = () =>
      api<AccountSummaryDto>('/account/summary')
        .then((s) => alive && setCount(s.openBets))
        .catch(() => undefined);
    void load();
    window.addEventListener(WALLET_CHANGED, load);
    return () => {
      alive = false;
      window.removeEventListener(WALLET_CHANGED, load);
    };
  }, [user]);
  return count;
}

/** Phone navigation; the header links take over from the md breakpoint. */
export function MobileTabBar() {
  const t = useT();
  const pathname = usePathname();
  const openBets = useOpenBets();
  const active = (tab: (typeof TABS)[number]) =>
    tab.href === '/'
      ? pathname === '/'
      : tab.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
  return (
    <>
      {/* Keeps the page end (footer) clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[calc(3.75rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        aria-label={t('Schnellnavigation')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="grid h-15 grid-cols-5">
          {TABS.map((tab) => {
            const on = active(tab);
            if (tab.featured) {
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={on ? 'page' : undefined}
                  className="flex flex-col items-center justify-end gap-0.5 pb-1.5 text-[11px] font-semibold text-fg"
                  data-testid="tab-casino"
                >
                  <span
                    className={cn(
                      '-mt-6 grid size-13 place-items-center rounded-full border-4 border-bg bg-[linear-gradient(135deg,#7c3aed,#4f6bff)] text-white shadow-lg shadow-accent/30',
                      on && 'ring-2 ring-accent-strong',
                    )}
                  >
                    <tab.icon className="size-6" aria-hidden="true" />
                  </span>
                  {t(tab.label)}
                </Link>
              );
            }
            const badge = tab.href === '/dashboard/bets' && openBets > 0 ? openBets : null;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                  on ? 'text-accent-strong' : 'text-fg-muted',
                )}
              >
                {on ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent-strong"
                  />
                ) : null}
                <span className="relative">
                  <tab.icon className="size-5" aria-hidden="true" />
                  {badge ? (
                    <span
                      className="tabular absolute -right-2.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-4 text-white"
                      data-testid="tab-open-bets"
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  ) : null}
                </span>
                {t(tab.label)}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
