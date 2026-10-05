'use client';

import { Button } from '@storm-bet/ui';
import { ChevronRight, Dices, Gift, Play, Trophy, Users } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { SectionHeader } from './section-header';

const TILES = [
  { href: '/casino', label: 'Casino', hint: 'Slots, Roulette, Blackjack', icon: Dices },
  { href: '/feed', label: 'Tipp-Feed', hint: 'Tipps anderer Spieler', icon: Users },
  { href: '/leaderboard', label: 'Rangliste', hint: 'Wer tippt am besten?', icon: Trophy },
  { href: '/promotions', label: 'Aktionen', hint: 'Boosts und Extras', icon: Gift },
];

/** Decorative rising curve – our own vector art, no game data. */
function CrashArt() {
  return (
    <svg viewBox="0 0 160 110" className="h-24 w-36 shrink-0 sm:h-28 sm:w-44" aria-hidden="true">
      <defs>
        <linearGradient id="crash-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.45" />
          <stop offset="1" stopColor="#4f5bff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="crash-line" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#4f5bff" />
          <stop offset="1" stopColor="#b49cff" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((y) => (
        <line key={y} x1="0" x2="160" y1={y} y2={y} stroke="#1f2433" strokeWidth="1" />
      ))}
      <path d="M4 104 C 60 100, 100 80, 140 18 L 140 108 L 4 108 Z" fill="url(#crash-fill)" />
      <path
        d="M4 104 C 60 100, 100 80, 140 18"
        fill="none"
        stroke="url(#crash-line)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="140" cy="18" r="6" fill="#fff" />
      <circle cx="140" cy="18" r="11" fill="#8b5cf6" fillOpacity="0.25" />
    </svg>
  );
}

/** Beyond sports: Storm Crash as a feature card, then the other extras. */
export function Features({ crashHref }: { crashHref: string }) {
  const t = useT();
  return (
    <section className="space-y-3" aria-labelledby="features-title">
      <SectionHeader id="features-title" title={t('Mehr entdecken')} />
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface bg-brand-soft">
        <div className="flex items-center gap-4 p-4 sm:p-5">
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-violet-strong">
              {t('Casino · Demo')}
            </p>
            <h3 className="text-xl font-extrabold tracking-tight">Storm Crash</h3>
            <p className="text-sm text-fg-muted">
              {t('Steig aus, bevor der Sturm abbricht. Jede Runde entscheidet der Server.')}
            </p>
            <Button size="sm" className="mt-1" asChild>
              <Link href={crashHref} data-testid="crash-card">
                <Play className="fill-current" /> {t('Demo spielen')}
              </Link>
            </Button>
          </div>
          <CrashArt />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {TILES.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2"
            data-testid="feature-tile"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-muted transition-colors group-hover:text-accent-strong">
              <tile.icon className="size-[18px]" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{t(tile.label)}</span>
              <span className="block truncate text-[11px] text-fg-subtle">{t(tile.hint)}</span>
            </span>
            <ChevronRight
              className="size-4 shrink-0 text-fg-subtle max-sm:hidden"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
