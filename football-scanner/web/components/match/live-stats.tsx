'use client';

import useSWR from 'swr';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LIVE, NA } from '@/lib/format';

interface Stats {
  status: string;
  elapsed: number | null;
  score: { home: number | null; away: number | null };
  home: Record<string, number | null> | null;
  away: Record<string, number | null> | null;
  events: {
    minute: number | null;
    extra: number | null;
    type: string;
    detail: string | null;
    player: string | null;
    assist: string | null;
    side: 'home' | 'away';
  }[];
}

const ROWS: [string, string][] = [
  ['Possession %', 'possession'],
  ['Shots', 'shots'],
  ['Shots on target', 'shots_on_target'],
  ['xG', 'xg'],
  ['Corners', 'corners'],
  ['Fouls', 'fouls'],
  ['Yellow cards', 'yellow_cards'],
  ['Red cards', 'red_cards'],
];

export function LiveStats({
  fixtureId,
  homeName,
  awayName,
}: {
  fixtureId: number;
  homeName: string;
  awayName: string;
}) {
  const { data } = useSWR<Stats>(`/api/matches/${fixtureId}/statistics`, {
    refreshInterval: (d?: Stats) => (d && LIVE.has(d.status) ? 30_000 : 300_000),
  });
  if (!data) return null;
  if (!data.home && !data.away) {
    return (
      <p className="text-sm text-muted-foreground">
        Match statistics appear here once the match starts (live) and after full-time.
      </p>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            {LIVE.has(data.status) ? `Live · ${data.elapsed ?? ''}'` : 'Match statistics'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-2 grid grid-cols-[1fr_auto_1fr] text-xs font-semibold text-muted-foreground">
            <span className="truncate">{homeName}</span>
            <span />
            <span className="truncate text-right">{awayName}</span>
          </div>
          {ROWS.map(([label, key]) => {
            const h = data.home?.[key] ?? null;
            const a = data.away?.[key] ?? null;
            const total = (h ?? 0) + (a ?? 0);
            return (
              <div key={key} className="py-1.5">
                <div className="grid grid-cols-[1fr_auto_1fr] text-sm">
                  <span className="num font-semibold">{h ?? NA}</span>
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span className="num text-right font-semibold">{a ?? NA}</span>
                </div>
                {total > 0 && (
                  <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="bg-primary" style={{ width: `${((h ?? 0) / total) * 100}%` }} />
                    <div
                      className="bg-signal-moderate"
                      style={{ width: `${((a ?? 0) / total) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
        </CardHeader>
        <CardContent>
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.events.map((e, i) => (
                <li key={i} className={e.side === 'away' ? 'text-right' : ''}>
                  <span className="num mr-2 text-xs text-muted-foreground">
                    {e.minute}
                    {e.extra ? `+${e.extra}` : ''}&apos;
                  </span>
                  <span className="font-medium">
                    {e.type === 'subst' ? 'Sub' : (e.detail ?? e.type)}
                  </span>{' '}
                  {e.player}
                  {e.assist ? <span className="text-muted-foreground"> ({e.assist})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
