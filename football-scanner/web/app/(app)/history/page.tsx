'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Empty, PageHeader, StatTile } from '@/components/common';
import { RankBadge, RiskBadge, ValueText } from '@/components/signal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NA, odds, pct, shortDate, units } from '@/lib/format';
import type { HistoryItem, Performance } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Stats {
  overall: Performance;
  pending: number;
  by_category: Record<string, Performance>;
  by_rank: Record<string, Performance>;
  equity_curve: { date: string; profit: number }[];
  stake_note: string;
}

const CATEGORIES = ['1X2', 'GOALS', 'CORNERS', 'CARDS', 'ASIAN', 'BTTS'];
const STATUS_TONE: Record<string, string> = {
  won: 'text-signal-strong',
  half_won: 'text-signal-strong',
  lost: 'text-signal-avoid',
  half_lost: 'text-signal-avoid',
  push: 'text-muted-foreground',
  void: 'text-muted-foreground',
  pending: 'text-signal-moderate',
};

export default function HistoryPage() {
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data: stats } = useSWR<Stats>('/api/history/stats', { refreshInterval: 300_000 });
  const qs = new URLSearchParams({ page: String(page) });
  if (category) qs.set('category', category);
  if (status) qs.set('status', status);
  const { data } = useSWR<{ items: HistoryItem[]; has_more: boolean }>(`/api/history?${qs}`);
  const o = stats?.overall;

  return (
    <>
      <PageHeader
        title="History"
        subtitle={stats?.stake_note ?? 'Every stored signal and its result.'}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="ROI"
          value={o?.roi == null ? NA : pct(o.roi)}
          tone={o?.roi == null ? 'default' : o.roi >= 0 ? 'good' : 'bad'}
        />
        <StatTile
          label="Profit"
          value={o ? units(o.profit) : NA}
          tone={o && o.profit >= 0 ? 'good' : 'bad'}
        />
        <StatTile label="Win rate" value={pct(o?.win_rate)} />
        <StatTile label="Average odds" value={odds(o?.average_odds)} />
        <StatTile
          label="Total bets"
          value={o?.settled_bets ?? NA}
          hint={`${stats?.pending ?? 0} pending`}
        />
        <StatTile label="Max drawdown" value={o ? units(-o.max_drawdown) : NA} tone="warn" />
      </div>

      {stats && stats.equity_curve.length > 1 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Cumulative profit (units)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={stats.equity_curve.map((p) => ({
                    t: new Date(p.date).getTime(),
                    profit: p.profit,
                  }))}
                >
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t: number) =>
                      new Date(t).toLocaleDateString([], { day: '2-digit', month: 'short' })
                    }
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} width={40} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                    labelFormatter={(t) => new Date(Number(t)).toLocaleDateString()}
                    formatter={(v) => [Number(v).toFixed(2), 'Profit (u)']}
                  />
                  <Area
                    type="monotone"
                    dataKey="profit"
                    stroke="hsl(var(--primary))"
                    fill="hsl(var(--primary) / 0.15)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {stats && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>By market group</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Group</TableHead>
                  <TableHead className="text-right">Bets</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead className="text-right">Avg odds</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Drawdown</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {CATEGORIES.map((c) => {
                  const s = stats.by_category[c];
                  if (!s) return null;
                  return (
                    <TableRow key={c}>
                      <TableCell className="font-medium">{c}</TableCell>
                      <TableCell className="num text-right">{s.settled_bets}</TableCell>
                      <TableCell className="num text-right">{pct(s.win_rate)}</TableCell>
                      <TableCell className="num text-right">{odds(s.average_odds)}</TableCell>
                      <TableCell
                        className={cn(
                          'num text-right',
                          s.profit >= 0 ? 'text-signal-strong' : 'text-signal-avoid',
                        )}
                      >
                        {units(s.profit)}
                      </TableCell>
                      <TableCell className="num text-right">{pct(s.roi)}</TableCell>
                      <TableCell className="num text-right">{units(-s.max_drawdown)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Signals</CardTitle>
          <div className="flex gap-2">
            <Select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(1);
              }}
              className="w-36"
            >
              <option value="">All groups</option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="w-36"
            >
              <option value="">All results</option>
              <option value="pending">Pending</option>
              <option value="settled">Settled</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="push">Push</option>
              <option value="void">Void</option>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {!data ? null : data.items.length === 0 ? (
            <Empty>No signals recorded yet.</Empty>
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead className="text-right">Odds</TableHead>
                      <TableHead className="text-right">Model</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead>Risk</TableHead>
                      <TableHead>Signal</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead className="text-right">P/L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {shortDate(h.date)}
                        </TableCell>
                        <TableCell className="max-w-[220px]">
                          <Link
                            href={`/matches/${h.fixture_id}`}
                            className="block truncate font-medium hover:text-primary"
                          >
                            {h.match}
                          </Link>
                          <div className="text-[11px] text-muted-foreground">{h.score ?? ''}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{h.label}</div>
                          <div className="text-[11px] text-muted-foreground">{h.category}</div>
                        </TableCell>
                        <TableCell className="num text-right">{odds(h.odds)}</TableCell>
                        <TableCell className="num text-right">{pct(h.probability)}</TableCell>
                        <TableCell className="text-right">
                          <ValueText value={h.value_pct} />
                        </TableCell>
                        <TableCell>
                          <RiskBadge risk={h.risk} />
                        </TableCell>
                        <TableCell>
                          <RankBadge rank={h.rank} compact />
                        </TableCell>
                        <TableCell
                          className={cn('text-xs font-semibold uppercase', STATUS_TONE[h.status])}
                        >
                          {h.status.replace('_', ' ')}
                          {h.result && (
                            <div className="text-[11px] font-normal normal-case text-muted-foreground">
                              {h.result}
                            </div>
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'num text-right font-semibold',
                            (h.profit ?? 0) > 0
                              ? 'text-signal-strong'
                              : (h.profit ?? 0) < 0
                                ? 'text-signal-avoid'
                                : '',
                          )}
                        >
                          {h.profit == null ? '—' : units(h.profit)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!data.has_more}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
