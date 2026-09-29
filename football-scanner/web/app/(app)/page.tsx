'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { RefreshCw } from 'lucide-react';

import { DataStatusNotice, Disclaimer, PageHeader, StatTile } from '@/components/common';
import { EvaluationsTable } from '@/components/evaluations-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { todayISO, userTimeZone } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Dashboard, User } from '@/lib/types';

export default function DashboardPage() {
  // Today is the viewer's local date, so it is set in the browser, not at build time.
  const [date, setDate] = useState('');
  useEffect(() => setDate(todayISO()), []);
  const tz = userTimeZone();
  const { data, isLoading, mutate, isValidating } = useSWR<Dashboard>(
    date ? `/api/dashboard?date=${date}&tz=${encodeURIComponent(tz)}&limit=30` : null,
    { refreshInterval: 60_000 },
  );
  const { data: me } = useSWR<User>('/api/auth/me');

  return (
    <>
      <PageHeader
        title="Football Value Scanner"
        subtitle={
          data?.data_status.last_analysis_at
            ? `Model last updated ${dateTime(data.data_status.last_analysis_at)} · odds ${dateTime(data.data_status.last_odds_at)}`
            : 'Model probabilities compared with bookmaker prices'
        }
      >
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-40"
        />
        <Button variant="outline" size="icon" onClick={() => mutate()} aria-label="Refresh">
          <RefreshCw className={isValidating ? 'animate-spin' : ''} />
        </Button>
      </PageHeader>

      <div className="mb-4">
        <DataStatusNotice status={data?.data_status} admin={me?.role === 'admin'} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {isLoading || !data ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px]" />)
        ) : (
          <>
            <StatTile
              label="Matches today"
              value={data.matches_today}
              hint={`${data.analysed} analysed`}
            />
            <StatTile label="Value opportunities" value={data.value_opportunities} tone="good" />
            <StatTile
              label="Strong signals"
              value={data.strong_signals}
              hint="Best + strong value"
              tone="good"
            />
            <StatTile
              label="High risk"
              value={data.high_risk}
              hint="Value signals rated high risk"
              tone="warn"
            />
          </>
        )}
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Today&apos;s best value</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <Skeleton className="h-64" />
          ) : (
            <EvaluationsTable
              rows={data.best_value}
              showMatch
              empty="No value opportunities for this date with the current data."
            />
          )}
        </CardContent>
      </Card>
      <Disclaimer />
    </>
  );
}
