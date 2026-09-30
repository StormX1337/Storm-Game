'use client';

import type { SportDto } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { Home, Radio, Trophy } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SportIcon } from '../sportsbook/sport-icon';
import { useT } from '@/i18n/client';

export function Sidebar({ sports }: { sports: SportDto[] }) {
  const t = useT();
  const pathname = usePathname();
  const liveTotal = sports.reduce((s, x) => s + x.liveCount, 0);
  const item = (href: string, active: boolean) =>
    cn(
      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
      active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
    );
  return (
    <nav aria-label={t('Sportarten')} className="space-y-6">
      <div className="space-y-0.5">
        <Link href="/" className={item('/', pathname === '/')}>
          <Home className="size-4" aria-hidden="true" /> {t('Start')}
        </Link>
        <Link href="/live" className={item('/live', pathname === '/live')}>
          <Radio className="size-4 text-live" aria-hidden="true" /> {t('Live')}
          {liveTotal ? (
            <span className="tabular ml-auto rounded bg-live-soft px-1.5 text-xs font-semibold text-live">
              {liveTotal}
            </span>
          ) : null}
        </Link>
        <Link href="/sports" className={item('/sports', pathname === '/sports')}>
          <Trophy className="size-4" aria-hidden="true" /> {t('Alle Sportarten')}
        </Link>
      </div>
      <div>
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
          {t('Sportarten')}
        </p>
        <div className="space-y-0.5">
          {sports.map((sport) => {
            const href = `/sports/${sport.key}`;
            return (
              <Link key={sport.key} href={href} className={item(href, pathname.startsWith(href))}>
                <SportIcon sport={sport.key} />
                {t(sport.name)}
                <span className="tabular ml-auto text-xs text-fg-subtle">{sport.eventCount}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

/** Horizontal sport tabs for small screens, where there is no sidebar. */
export function SportTabs({ sports }: { sports: SportDto[] }) {
  const t = useT();
  const pathname = usePathname();
  const tab = (href: string, active: boolean) =>
    cn(
      'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
      active
        ? 'border-accent/40 bg-accent-soft text-fg'
        : 'border-border bg-surface text-fg-muted hover:text-fg',
    );
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 xl:hidden">
      <Link href="/live" className={tab('/live', pathname === '/live')}>
        <span className="size-1.5 rounded-full bg-live" /> {t('Live')}
      </Link>
      {sports.map((s) => (
        <Link
          key={s.key}
          href={`/sports/${s.key}`}
          className={tab(`/sports/${s.key}`, pathname.startsWith(`/sports/${s.key}`))}
        >
          <SportIcon sport={s.key} /> {t(s.name)}
        </Link>
      ))}
    </div>
  );
}
