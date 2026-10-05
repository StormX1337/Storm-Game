'use client';

import type { AccountSummaryDto } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { House, Radio, Receipt, Trophy, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useT } from '@/i18n/client';
import { useSession, WALLET_CHANGED } from '../providers/session';

type Tab = {
  key: string;
  href: string;
  label: string;
  icon: typeof House;
  active: (pathname: string) => boolean;
};

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

const TABS: Tab[] = [
  { key: 'home', href: '/', label: 'Start', icon: House, active: (p) => p === '/' },
  {
    key: 'sport',
    href: '/sports',
    label: 'Sport',
    icon: Trophy,
    active: (p) => ['/sports', '/events', '/search', '/bet-builder'].some((base) => under(p, base)),
  },
  { key: 'live', href: '/live', label: 'Live', icon: Radio, active: (p) => under(p, '/live') },
  {
    key: 'bets',
    href: '/dashboard/bets',
    label: 'Wetten',
    icon: Receipt,
    active: (p) => under(p, '/dashboard/bets'),
  },
  {
    key: 'account',
    href: '/dashboard',
    label: 'Konto',
    icon: UserRound,
    active: (p) =>
      (under(p, '/dashboard') && !under(p, '/dashboard/bets')) ||
      ['/login', '/register'].some((base) => under(p, base)),
  },
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

/**
 * Phone navigation: five fixed destinations. The active tab always follows the
 * route; pages outside these sections (casino, feed …) leave all tabs inactive.
 */
export function MobileTabBar() {
  const t = useT();
  const pathname = usePathname();
  const { user } = useSession();
  const openBets = useOpenBets();
  return (
    <>
      {/* Keeps the page end (footer) clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[calc(4rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        aria-label={t('Schnellnavigation')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      >
        <div className="grid h-16 grid-cols-5">
          {TABS.map((tab) => {
            const on = tab.active(pathname);
            const href = tab.key === 'account' && !user ? '/login' : tab.href;
            const badge = tab.key === 'bets' && openBets > 0 ? openBets : null;
            return (
              <Link
                key={tab.key}
                href={href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-1 text-[11px] transition-colors',
                  on ? 'font-semibold text-accent-strong' : 'font-medium text-fg-subtle',
                )}
                data-testid={`tab-${tab.key}`}
              >
                {on ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 h-0.5 w-8 rounded-b-full bg-accent shadow-[0_0_12px_rgb(79_91_255/0.9)]"
                  />
                ) : null}
                <span className="relative">
                  <tab.icon
                    className={cn('size-[22px]', on && 'drop-shadow-[0_0_6px_rgb(79_91_255/0.55)]')}
                    strokeWidth={on ? 2.2 : 1.8}
                    aria-hidden="true"
                  />
                  {badge ? (
                    <span
                      className="tabular absolute -right-2.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-4 text-white ring-2 ring-bg"
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
