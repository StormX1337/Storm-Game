'use client';

import type { SportDto } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { Dices, Gift, Home, Layers, LayoutGrid, Radio, Trophy, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { SportIcon } from '../sportsbook/sport-icon';
import { useT } from '@/i18n/client';

const EXTRAS = [
  { href: '/bet-builder', label: 'Bet Builder', icon: Layers },
  { href: '/promotions', label: 'Aktionen', icon: Gift },
  { href: '/casino', label: 'Casino', icon: Dices },
  { href: '/feed', label: 'Tipp-Feed', icon: Users },
  { href: '/leaderboard', label: 'Rangliste', icon: Trophy },
];

function SideLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
        active
          ? 'bg-surface-2 font-semibold text-fg'
          : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent"
        />
      ) : null}
      {children}
    </Link>
  );
}

/** Desktop: sports navigation in the left column. */
export function Sidebar({ sports }: { sports: SportDto[] }) {
  const t = useT();
  const pathname = usePathname();
  const liveTotal = sports.reduce((s, x) => s + x.liveCount, 0);
  const heading = 'px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle';
  return (
    <nav aria-label={t('Sportarten')} className="space-y-6">
      <div className="space-y-0.5">
        <SideLink href="/" active={pathname === '/'}>
          <Home className="size-4" aria-hidden="true" /> {t('Start')}
        </SideLink>
        <SideLink href="/live" active={pathname === '/live'}>
          <Radio className="size-4 text-live" aria-hidden="true" /> {t('Live')}
          {liveTotal ? (
            <span className="tabular ml-auto rounded-full bg-live-soft px-1.5 text-[11px] font-semibold text-live">
              {liveTotal}
            </span>
          ) : null}
        </SideLink>
        <SideLink href="/sports" active={pathname === '/sports'}>
          <LayoutGrid className="size-4" aria-hidden="true" /> {t('Alle Sportarten')}
        </SideLink>
      </div>
      <div>
        <p className={heading}>{t('Sportarten')}</p>
        <div className="space-y-0.5">
          {sports.map((sport) => {
            const href = `/sports/${sport.key}`;
            return (
              <SideLink key={sport.key} href={href} active={pathname.startsWith(href)}>
                <SportIcon sport={sport.key} />
                <span className="truncate">{t(sport.name)}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {sport.liveCount ? (
                    <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
                  ) : null}
                  <span className="tabular text-xs font-normal text-fg-subtle">
                    {sport.eventCount}
                  </span>
                </span>
              </SideLink>
            );
          })}
        </div>
      </div>
      <div>
        <p className={heading}>{t('Extras')}</p>
        <div className="space-y-0.5">
          {EXTRAS.map((item) => (
            <SideLink
              key={item.href}
              href={item.href}
              active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
            >
              <item.icon className="size-4" aria-hidden="true" /> {t(item.label)}
            </SideLink>
          ))}
        </div>
      </div>
    </nav>
  );
}

/** Phones and tablets: sports as a swipeable row of pills (no sidebar there). */
export function SportTabs({ sports }: { sports: SportDto[] }) {
  const t = useT();
  const pathname = usePathname();
  const liveTotal = sports.reduce((s, x) => s + x.liveCount, 0);
  const ref = useRef<HTMLElement>(null);
  // The current sport is scrolled into view when it sits further right.
  useEffect(() => {
    const nav = ref.current;
    const chip = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !chip) return;
    if (chip.offsetLeft + chip.offsetWidth > nav.clientWidth + nav.scrollLeft)
      nav.scrollTo({ left: Math.max(0, chip.offsetLeft - 16) });
  }, [pathname]);
  const pill = (active: boolean) =>
    cn(
      'flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-[13px] font-semibold transition-colors active:scale-[0.97] [&_svg]:size-4',
      active
        ? 'border-accent/50 bg-accent-soft text-fg [&_svg]:text-accent-strong'
        : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
    );
  return (
    <nav
      ref={ref}
      aria-label={t('Sportarten')}
      className="scrollbar-none -mx-4 flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 xl:hidden"
    >
      <Link
        href="/live"
        aria-current={pathname === '/live' ? 'page' : undefined}
        className={cn(pill(pathname === '/live'), 'snap-start')}
      >
        <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
        {t('Live')}
        {liveTotal ? <span className="tabular text-[11px] text-live">{liveTotal}</span> : null}
      </Link>
      {sports.map((s) => {
        const href = `/sports/${s.key}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={s.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(pill(active), 'snap-start')}
          >
            <SportIcon sport={s.key} /> {t(s.name)}
          </Link>
        );
      })}
      <Link
        href="/sports"
        aria-current={pathname === '/sports' ? 'page' : undefined}
        className={cn(pill(pathname === '/sports'), 'snap-start')}
      >
        <LayoutGrid className="size-4" aria-hidden="true" /> {t('Mehr')}
      </Link>
    </nav>
  );
}
