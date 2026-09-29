'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowLeft, RefreshCw } from 'lucide-react';

import { Disclaimer, Notice } from '@/components/common';
import { EvaluationsTable } from '@/components/evaluations-table';
import { LiveStats } from '@/components/match/live-stats';
import { OddsPanel } from '@/components/match/odds-panel';
import {
  ATTACK_ROWS,
  COUNT_ROWS,
  CompareTable,
  DEFENCE_ROWS,
  FormCompare,
  H2H,
  ModelCard,
  TopScores,
} from '@/components/match/overview';
import { SquadCard, TacticsCard } from '@/components/match/squad';
import { Histogram } from '@/components/odds-chart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { post } from '@/lib/api';
import { LIVE, NA, STATUS_LABEL, dateTime, num } from '@/lib/format';
import type { Evaluation, MatchAnalysis, MatchDetail, User } from '@/lib/types';

const byMarket = (evs: Evaluation[], ...markets: string[]) =>
  evs.filter((e) => markets.includes(e.market));

function Section({ title, rows, empty }: { title: string; rows: Evaluation[]; empty?: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <EvaluationsTable rows={rows} initialSort="rank" empty={empty ?? 'Not available.'} />
    </div>
  );
}

function sortedByLine(rows: Evaluation[]) {
  return [...rows].sort(
    (a, b) =>
      (a.team ?? '').localeCompare(b.team ?? '') * -1 ||
      (a.line ?? 0) - (b.line ?? 0) ||
      b.side.localeCompare(a.side),
  );
}

export default function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading, mutate } = useSWR<MatchDetail>(`/api/matches/${id}`, {
    refreshInterval: 60_000,
  });
  const { data: me } = useSWR<User>('/api/auth/me');
  const [refreshing, setRefreshing] = useState(false);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const { fixture: f, analysis: a } = data;
  const live = LIVE.has(f.status);

  async function reanalyse() {
    setRefreshing(true);
    try {
      await post(`/api/matches/${id}/refresh`);
      await mutate();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <Link
        href="/matches"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Matches
      </Link>

      <Card className="mb-5">
        <CardContent className="p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {f.country ? `${f.country} · ` : ''}
              {f.league ?? NA}
              {f.round ? ` · ${f.round}` : ''}
            </span>
            <span>
              {dateTime(f.kickoff)} · {STATUS_LABEL[f.status] ?? f.status}
              {live && f.elapsed ? ` ${f.elapsed}'` : ''}
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            <div className="break-words text-right text-base font-bold leading-tight sm:text-lg md:text-2xl">
              {f.home}
            </div>
            <div className="num rounded-md bg-muted px-3 py-1 text-xl font-bold md:text-3xl">
              {f.home_goals ?? '–'} : {f.away_goals ?? '–'}
            </div>
            <div className="break-words text-base font-bold leading-tight sm:text-lg md:text-2xl">
              {f.away}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Venue: {f.venue ?? NA}</span>
            <span>Referee: {f.referee ?? NA}</span>
            {a && <span>Model updated {dateTime(a.computed_at)}</span>}
            {me?.role === 'admin' && (
              <Button variant="ghost" size="sm" onClick={reanalyse} disabled={refreshing}>
                <RefreshCw className={refreshing ? 'animate-spin' : ''} /> Re-analyse
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!a ? (
        <Notice tone="warn">
          This match has not been analysed. Analysis runs for scheduled matches in enabled leagues.
        </Notice>
      ) : (
        <Analysis a={a} homeName={f.home} awayName={f.away} fixtureId={f.fixture_id} />
      )}
      <Disclaimer />
    </>
  );
}

function Analysis({
  a,
  homeName,
  awayName,
  fixtureId,
}: {
  a: MatchAnalysis;
  homeName: string;
  awayName: string;
  fixtureId: number;
}) {
  const ev = a.evaluations;
  const insufficient = Object.values(a.stats).filter((s) => s.status !== 'OK');
  return (
    <>
      {insufficient.length > 0 && (
        <div className="mb-4">
          <Notice tone="warn">
            {insufficient.map((s) => (
              <p key={s.stat}>
                <span className="font-semibold uppercase">{s.stat}</span>: INSUFFICIENT DATA —{' '}
                {s.reason}
              </p>
            ))}
          </Notice>
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="mb-1 w-full md:w-auto">
          {['overview', 'result', 'goals', 'corners', 'cards', 'asian', 'statistics', 'odds'].map(
            (t) => (
              <TabsTrigger key={t} value={t}>
                {t}
              </TabsTrigger>
            ),
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <ModelCard
              model={a.stats.goals}
              title="Expected goals"
              homeName={homeName}
              awayName={awayName}
            />
            <div className="lg:col-span-2">
              <TopScores a={a} />
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CompareTable
              title="Attack"
              rows={ATTACK_ROWS}
              home={a.context.home.attack}
              away={a.context.away.attack}
              homeName={homeName}
              awayName={awayName}
            />
            <CompareTable
              title="Defence"
              rows={DEFENCE_ROWS}
              home={a.context.home.defence}
              away={a.context.away.defence}
              homeName={homeName}
              awayName={awayName}
            />
          </div>
          <FormCompare a={a} homeName={homeName} awayName={awayName} />
          <SquadCard
            home={a.context.home_squad}
            away={a.context.away_squad}
            homeName={homeName}
            awayName={awayName}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <TacticsCard
              home={a.context.home_tactics}
              away={a.context.away_tactics}
              hs={a.context.home_schedule}
              as_={a.context.away_schedule}
              homeName={homeName}
              awayName={awayName}
            />
            <H2H a={a} />
          </div>
        </TabsContent>

        <TabsContent value="result" className="space-y-5">
          <Section title="1X2" rows={byMarket(ev, '1x2')} />
          <Section title="Double chance" rows={byMarket(ev, 'double_chance')} />
          <Section title="Draw no bet" rows={byMarket(ev, 'dnb')} />
        </TabsContent>

        <TabsContent value="goals" className="space-y-5">
          <Section title="Over / Under goals" rows={sortedByLine(byMarket(ev, 'over_under'))} />
          <Section title="Both teams to score" rows={byMarket(ev, 'btts')} />
          <Section title="Team goals" rows={sortedByLine(byMarket(ev, 'team_goals'))} />
        </TabsContent>

        <TabsContent value="corners" className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <ModelCard
              model={a.stats.corners}
              title="Expected corners"
              homeName={homeName}
              awayName={awayName}
            />
            <CompareTable
              title="Corners (last 10)"
              rows={COUNT_ROWS}
              home={a.context.home.corners}
              away={a.context.away.corners}
              homeName={homeName}
              awayName={awayName}
            />
          </div>
          <Section title="Over / Under corners" rows={sortedByLine(byMarket(ev, 'corners_ou'))} />
          <Section title="Team corners" rows={sortedByLine(byMarket(ev, 'team_corners'))} />
        </TabsContent>

        <TabsContent value="cards" className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            <ModelCard
              model={a.stats.cards}
              title="Expected cards"
              homeName={homeName}
              awayName={awayName}
            />
            <CompareTable
              title="Cards (last 10)"
              rows={COUNT_ROWS}
              home={a.context.home.cards}
              away={a.context.away.cards}
              homeName={homeName}
              awayName={awayName}
            />
            <RefereeCard a={a} />
          </div>
          <Section title="Over / Under cards" rows={sortedByLine(byMarket(ev, 'cards_ou'))} />
          <Section title="Team cards" rows={sortedByLine(byMarket(ev, 'team_cards'))} />
        </TabsContent>

        <TabsContent value="asian" className="space-y-5">
          <Section title="Asian handicap" rows={sortedByLine(byMarket(ev, 'asian_handicap'))} />
          <Section
            title="Asian goals (total)"
            rows={sortedByLine(byMarket(ev, 'asian_total', 'over_under'))}
          />
          <Section title="Asian corners" rows={sortedByLine(byMarket(ev, 'asian_corners'))} />
          <Section title="Asian cards" rows={sortedByLine(byMarket(ev, 'asian_cards'))} />
          <p className="text-[11px] text-muted-foreground">
            Integer lines refund on the exact number; quarter lines split the stake over the two
            neighbouring lines. Probabilities shown exclude refunded stake, so fair odds are exactly
            1 / probability.
          </p>
        </TabsContent>

        <TabsContent value="statistics" className="space-y-4">
          <LiveStats fixtureId={fixtureId} homeName={homeName} awayName={awayName} />
        </TabsContent>

        <TabsContent value="odds">
          <OddsPanel fixtureId={fixtureId} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function RefereeCard({ a }: { a: MatchAnalysis }) {
  const r = a.context.referee;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Referee</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!r ? (
          <p className="text-muted-foreground">Referee not announced — {NA}</p>
        ) : (
          <>
            <div className="font-semibold">{r.name}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat k="Matches stored" v={String(r.matches)} />
              <Stat k="Cards / match" v={r.matches ? num(r.avg_cards) : NA} />
              <Stat k="Fouls / match" v={num(r.avg_fouls, 1)} />
              <Stat
                k="Home / away cards"
                v={`${num(r.avg_home_cards, 1)} / ${num(r.avg_away_cards, 1)}`}
              />
            </div>
            {Object.keys(a.context.referee_distribution).length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Cards per match (history)
                </div>
                <Histogram data={a.context.referee_distribution} label="cards" />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{k}</div>
      <div className="num font-semibold">{v}</div>
    </div>
  );
}
