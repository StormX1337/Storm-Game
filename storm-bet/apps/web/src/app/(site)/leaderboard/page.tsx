import type { LeaderboardDto, LeaderboardEntryDto } from '@storm-bet/types';
import { Card, cn, EmptyState } from '@storm-bet/ui';
import { Trophy } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LeaderboardJoin } from '@/components/leaderboard/leaderboard-join';
import { PageHeader } from '@/components/sportsbook/page-header';
import { getT } from '@/i18n/server';
import { formatMoney } from '@/lib/format';
import { tryServerApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Rangliste') };
}

const PERIODS = [
  { key: 'week', label: 'Diese Woche' },
  { key: 'month', label: 'Dieser Monat' },
] as const;
const RANKINGS = [
  { key: 'profit', label: 'Bilanz' },
  { key: 'hitrate', label: 'Trefferquote' },
] as const;

const percent = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)} %`);
const MEDALS = ['bg-[#f5c542] text-black', 'bg-[#c9d1dc] text-black', 'bg-[#d08a4f] text-black'];

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; by?: string }>;
}) {
  const t = await getT();
  const params = await searchParams;
  const period = params.period === 'month' ? 'month' : 'week';
  const by = params.by === 'hitrate' ? 'hitrate' : 'profit';
  const board = await tryServerApi<LeaderboardDto>(`/leaderboard?period=${period}&by=${by}`);
  const href = (p: string, b: string) => `/leaderboard?period=${p}&by=${b}`;
  const chip = (on: boolean) =>
    cn(
      'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
      on ? 'border-accent bg-accent-soft text-fg' : 'border-border text-fg-muted hover:text-fg',
    );

  const row = (e: LeaderboardEntryDto) => (
    <li
      key={e.userId}
      className={cn('flex items-center gap-3 px-4 py-3', e.me && 'bg-accent-soft/60')}
      data-testid="leaderboard-row"
    >
      <span
        className={cn(
          'tabular grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
          MEDALS[e.rank - 1] ?? 'bg-surface-3 text-fg-muted',
        )}
      >
        {e.rank}
      </span>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold">
        {initials(e.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {e.name}
          {e.me ? (
            <span className="ml-1.5 text-xs font-normal text-accent-strong">{t('(du)')}</span>
          ) : null}
        </span>
        <span className="block text-xs text-fg-muted">
          {t('{0} Wetten · {1} gewonnen', [e.settled, e.won])}
        </span>
      </span>
      <span className="text-right">
        <span
          className={cn(
            'tabular block text-sm font-bold',
            by === 'hitrate' ? 'text-fg' : e.profit >= 0 ? 'text-up' : 'text-down',
          )}
        >
          {by === 'hitrate' ? percent(e.hitRate) : formatMoney(e.profit, { sign: true })}
        </span>
        <span className="tabular block text-xs text-fg-muted">
          {by === 'hitrate' ? formatMoney(e.profit, { sign: true }) : percent(e.hitRate)}
        </span>
      </span>
    </li>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('Rangliste')}
        description={t(
          'Wer tippt am besten? Es zählen abgerechnete Sportwetten im Zeitraum. Nur Spieler, die mitmachen, erscheinen hier – mit Anzeigename und Ergebnis.',
        )}
      />
      <div className="flex flex-wrap gap-2">
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <Link key={p.key} href={href(p.key, by)} className={chip(period === p.key)}>
              {t(p.label)}
            </Link>
          ))}
        </div>
        <span className="mx-1 hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
        <div className="flex gap-2">
          {RANKINGS.map((r) => (
            <Link key={r.key} href={href(period, r.key)} className={chip(by === r.key)}>
              {t(r.label)}
            </Link>
          ))}
        </div>
      </div>

      {board?.me ? (
        <Card className="p-4" data-testid="leaderboard-me">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">{t('Dein Ergebnis')}</p>
              <p className="text-xs text-fg-muted">
                {board.me.optIn
                  ? board.me.rank
                    ? t('Platz {0}', [board.me.rank])
                    : by === 'hitrate'
                      ? t('Ab {0} entschiedenen Wetten wirst du gelistet.', [board.minDecided])
                      : t('Noch keine abgerechnete Wette im Zeitraum.')
                  : t('Du bist nicht in der Rangliste.')}
              </p>
            </div>
            <LeaderboardJoin optIn={board.me.optIn} />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              [t('Bilanz'), formatMoney(board.me.profit, { sign: true })],
              [t('Wetten'), String(board.me.settled)],
              [t('Trefferquote'), percent(board.me.hitRate)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-surface-2 px-2 py-2">
                <dt className="text-[11px] text-fg-muted">{label}</dt>
                <dd className="tabular text-sm font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : board ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-fg-muted">{t('Melde dich an, um mitzumachen.')}</p>
          <Link
            href="/login?next=/leaderboard"
            className="text-sm font-medium text-accent-strong hover:underline"
          >
            {t('Anmelden')}
          </Link>
        </Card>
      ) : null}

      {by === 'hitrate' && board ? (
        <p className="text-xs text-fg-muted">
          {t('Trefferquote: gewonnene unter gewonnenen und verlorenen Wetten, ab {0} Wetten.', [
            board.minDecided,
          ])}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        {board && board.entries.length > 0 ? (
          <ol className="divide-y divide-border">{board.entries.map(row)}</ol>
        ) : (
          <EmptyState
            icon={<Trophy />}
            title={t('Noch niemand in der Rangliste')}
            description={t('Mach mit – deine abgerechneten Sportwetten im Zeitraum zählen.')}
          />
        )}
      </Card>
      <p className="text-xs text-fg-subtle">
        {t('Spielgeld ohne Geldwert. Es gibt keine Preise oder Gewinne für die Platzierung.')}
      </p>
    </div>
  );
}
