'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle } from 'lucide-react';

import { OddsChart } from '@/components/odds-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NA, dateTime, odds, signedPct } from '@/lib/format';
import type { OddsSelection } from '@/lib/types';
import { cn } from '@/lib/utils';

export function OddsPanel({ fixtureId }: { fixtureId: number }) {
  const { data } = useSWR<{ selections: OddsSelection[] }>(`/api/matches/${fixtureId}/odds`, {
    refreshInterval: 120_000,
  });
  const [key, setKey] = useState<string | null>(null);
  const mostMoved = data?.selections.reduce<OddsSelection | null>(
    (best, s) =>
      Math.abs(s.movement?.movement_pct ?? 0) > Math.abs(best?.movement?.movement_pct ?? -1)
        ? s
        : best,
    null,
  );
  const selected = key ?? mostMoved?.key ?? null;
  const { data: detail } = useSWR<OddsSelection>(
    selected ? `/api/matches/${fixtureId}/odds?key=${encodeURIComponent(selected)}` : null,
  );

  if (!data) return null;
  if (data.selections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No bookmaker prices recorded for this match.</p>
    );
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Selection</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Current</TableHead>
              <TableHead className="text-right">Lowest</TableHead>
              <TableHead className="text-right">Highest</TableHead>
              <TableHead className="text-right">Movement</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.selections.map((s) => {
              const m = s.movement;
              return (
                <TableRow
                  key={s.key}
                  className={cn('cursor-pointer', selected === s.key && 'bg-primary/10')}
                  onClick={() => setKey(s.key)}
                >
                  <TableCell>
                    <div className="flex items-center gap-1.5 font-medium">
                      {s.label}
                      {m?.alert && (
                        <AlertTriangle
                          className="h-3.5 w-3.5 text-signal-moderate"
                          aria-label={m.alert}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">{odds(m?.opening)}</TableCell>
                  <TableCell className="num text-right font-semibold">{odds(m?.current)}</TableCell>
                  <TableCell className="num text-right">{odds(m?.lowest)}</TableCell>
                  <TableCell className="num text-right">{odds(m?.highest)}</TableCell>
                  <TableCell
                    className={cn(
                      'num text-right',
                      m && m.movement_pct < 0
                        ? 'text-signal-strong'
                        : m && m.movement_pct > 0
                          ? 'text-signal-avoid'
                          : '',
                    )}
                  >
                    {m ? signedPct(m.movement_pct) : NA}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {dateTime(m?.updated_at)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{detail?.label ?? 'Odds movement'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {detail?.series && <OddsChart series={detail.series} />}
          {detail?.movement?.alert && (
            <p className="flex items-center gap-2 text-sm text-signal-moderate">
              <AlertTriangle className="h-4 w-4" /> {detail.movement.alert} (
              {signedPct(detail.movement.movement_pct)}, {detail.movement.direction})
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Movement is a change in price, nothing more. Prices move on news, team selection and
            money; the scanner never treats movement as evidence that a match is arranged.
          </p>
          {detail && Object.keys(detail.bookmakers).length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Current prices by bookmaker
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {Object.entries(detail.bookmakers)
                  .sort((a, b) => b[1] - a[1])
                  .map(([b, o]) => (
                    <div key={b} className="flex justify-between">
                      <span className="truncate text-muted-foreground">{b}</span>
                      <span className="num font-medium">{odds(o)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
