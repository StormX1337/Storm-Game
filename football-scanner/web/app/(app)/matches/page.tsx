'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';

import { Empty, PageHeader } from '@/components/common';
import { RankBadge, ValueText } from '@/components/signal';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { todayISO, userTimeZone } from '@/lib/api';
import { LIVE, NA, STATUS_LABEL, kickoff, odds } from '@/lib/format';
import type { MatchCard, Meta } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function MatchesPage() {
  // Today is the viewer's local date, so it is set in the browser, not at build time.
  const [date, setDate] = useState('');
  useEffect(() => setDate(todayISO()), []);
  const [league, setLeague] = useState('');
  const [q, setQ] = useState('');
  const { data: meta } = useSWR<Meta>('/api/meta');
  const params = new URLSearchParams({ date, tz: userTimeZone() });
  if (league) params.append('league_id', league);
  if (q) params.set('q', q);
  const { data, isLoading } = useSWR<{ matches: MatchCard[] }>(
    date ? `/api/matches?${params}` : null,
    {
      refreshInterval: 60_000,
    },
  );

  const byLeague = new Map<string, MatchCard[]>();
  for (const m of data?.matches ?? []) {
    const k = `${m.country ?? ''} — ${m.league ?? NA}`;
    byLeague.set(k, [...(byLeague.get(k) ?? []), m]);
  }

  return (
    <>
      <PageHeader title="Matches" subtitle="Every scheduled match in the enabled leagues.">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-40"
        />
        <Select value={league} onChange={(e) => setLeague(e.target.value)} className="w-48">
          <option value="">All leagues</option>
          {meta?.leagues.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Input
          placeholder="Search team"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-44"
        />
      </PageHeader>

      {isLoading || !data ? (
        <Skeleton className="h-64" />
      ) : byLeague.size === 0 ? (
        <Empty>No matches for this date in the enabled leagues.</Empty>
      ) : (
        <div className="space-y-5">
          {[...byLeague.entries()].map(([name, matches]) => (
            <section key={name}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {name}
              </h2>
              <Card className="divide-y">
                {matches.map((m) => (
                  <MatchRow key={m.fixture_id} m={m} />
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function MatchRow({ m }: { m: MatchCard }) {
  const live = LIVE.has(m.status);
  return (
    <Link
      href={`/matches/${m.fixture_id}`}
      className="grid grid-cols-[64px_1fr] items-center gap-3 p-3 transition-colors hover:bg-muted/40 md:grid-cols-[72px_1fr_240px]"
    >
      <div className="text-center">
        <div className={cn('num text-sm font-semibold', live && 'text-signal-best')}>
          {live ? `${m.elapsed ?? ''}'` : kickoff(m.kickoff)}
        </div>
        <div className="text-[10px] uppercase text-muted-foreground">
          {STATUS_LABEL[m.status] ?? m.status}
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{m.home}</span>
          <span className="num font-semibold">{m.home_goals ?? ''}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{m.away}</span>
          <span className="num font-semibold">{m.away_goals ?? ''}</span>
        </div>
      </div>
      <div className="col-span-2 flex items-center justify-between gap-2 text-xs md:col-span-1 md:justify-end">
        {!m.analysed ? (
          <span className="text-muted-foreground">Not analysed yet</span>
        ) : m.best ? (
          <>
            <span className="truncate text-muted-foreground">
              {m.best.label} @ {odds(m.best.odds ?? null)}
            </span>
            <ValueText value={m.best.value_pct ?? null} />
            {m.best.rank && <RankBadge rank={m.best.rank} compact />}
          </>
        ) : (
          <span className="text-muted-foreground">
            {m.insufficient?.length
              ? `Insufficient data: ${m.insufficient.join(', ')}`
              : 'No value found'}
          </span>
        )}
      </div>
    </Link>
  );
}
