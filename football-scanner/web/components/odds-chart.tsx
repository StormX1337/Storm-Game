'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export function OddsChart({ series }: { series: { time: string; odds: number }[] }) {
  const data = series.map((p) => ({ t: new Date(p.time).getTime(), odds: p.odds }));
  if (data.length === 0) return null;
  // A single observation still gets a visible (flat) line.
  const points = data.length === 1 && data[0] ? [data[0], { ...data[0], t: Date.now() }] : data;
  const values = points.map((d) => d.odds);
  const pad = Math.max(0.02, (Math.max(...values) - Math.min(...values)) * 0.25);
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) =>
              new Date(t).toLocaleString([], { day: '2-digit', hour: '2-digit', minute: '2-digit' })
            }
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            stroke="hsl(var(--border))"
          />
          <YAxis
            domain={[Math.min(...values) - pad, Math.max(...values) + pad]}
            tickFormatter={(v: number) => v.toFixed(2)}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            stroke="hsl(var(--border))"
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
            formatter={(v) => [Number(v).toFixed(2), 'Best odds']}
          />
          <Line
            type="stepAfter"
            dataKey="odds"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Histogram({ data, label }: { data: Record<string, number>; label: string }) {
  const entries = Object.entries(data).map(([k, v]) => ({ k: Number(k), v }));
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e.v));
  return (
    <div>
      <div className="flex h-28 items-end gap-1">
        {entries.map((e) => (
          <div key={e.k} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <div
              className="w-full rounded-t bg-primary/70"
              style={{ height: `${(e.v / max) * 100}%` }}
              title={`${e.v} match(es) with ${e.k} ${label}`}
            />
            <span className="num text-[10px] text-muted-foreground">{e.k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
