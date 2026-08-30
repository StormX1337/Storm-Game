'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, CardTitle, cn } from '@storm/ui';

export interface ChartPoint {
  t: string;
  [key: string]: string | number | null;
}

export interface SeriesConfig {
  key: string;
  label: string;
  /** CSS colour; defaults walk the chart palette. */
  color?: string;
  format?: (value: number) => string;
}

const PALETTE = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

/**
 * Time-series chart used for CPU, memory, disk and network.
 *
 * Ticks are thinned by hand rather than left to Recharts: at one sample per
 * second an automatic axis renders an unreadable smear of labels.
 */
export function ResourceChart({
  title,
  data,
  series,
  variant = 'area',
  height = 220,
  yFormatter,
  emptyMessage = 'No samples yet.',
  action,
  className,
}: {
  title?: string;
  data: ChartPoint[];
  series: SeriesConfig[];
  variant?: 'area' | 'line';
  height?: number;
  yFormatter?: (value: number) => string;
  emptyMessage?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  const formatTime = React.useCallback((value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }, []);

  const body =
    data.length === 0 ? (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    ) : (
      <ResponsiveContainer width="100%" height={height}>
        {variant === 'area' ? (
          <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((entry, index) => (
                <linearGradient key={entry.key} id={`fill-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={entry.color ?? PALETTE[index % PALETTE.length]}
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="100%"
                    stopColor={entry.color ?? PALETTE[index % PALETTE.length]}
                    stopOpacity={0.02}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={formatTime}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => (yFormatter ? yFormatter(value) : String(value))}
            />
            <Tooltip content={<ChartTooltip series={series} formatTime={formatTime} />} />
            {series.length > 1 ? (
              <Legend
                verticalAlign="top"
                align="right"
                height={28}
                iconType="circle"
                iconSize={8}
                formatter={(value: string) => (
                  <span className="text-xs text-muted-foreground">{value}</span>
                )}
              />
            ) : null}
            {series.map((entry, index) => (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.label}
                stroke={entry.color ?? PALETTE[index % PALETTE.length]}
                strokeWidth={2}
                fill={`url(#fill-${entry.key})`}
                isAnimationActive={false}
                dot={false}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={formatTime}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => (yFormatter ? yFormatter(value) : String(value))}
            />
            <Tooltip content={<ChartTooltip series={series} formatTime={formatTime} />} />
            {series.length > 1 ? (
              <Legend
                verticalAlign="top"
                align="right"
                height={28}
                iconType="circle"
                iconSize={8}
                formatter={(value: string) => (
                  <span className="text-xs text-muted-foreground">{value}</span>
                )}
              />
            ) : null}
            {series.map((entry, index) => (
              <Line
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.label}
                stroke={entry.color ?? PALETTE[index % PALETTE.length]}
                strokeWidth={2}
                isAnimationActive={false}
                dot={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    );

  if (!title) return <div className={className}>{body}</div>;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {action}
      </CardHeader>
      <div className="px-2 pb-3">{body}</div>
    </Card>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  name?: string;
  value?: number;
  color?: string;
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  formatTime,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  series: SeriesConfig[];
  formatTime: (value: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl">
      <p className="mb-1.5 text-xs text-muted-foreground">{label ? formatTime(label) : ''}</p>
      <div className="space-y-1">
        {payload.map((entry) => {
          const config = series.find((item) => item.key === entry.dataKey);
          const value = typeof entry.value === 'number' ? entry.value : 0;
          return (
            <div key={String(entry.dataKey)} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-muted-foreground">{config?.label ?? entry.name}</span>
              <span className="ml-auto font-medium tabular-nums">
                {config?.format ? config.format(value) : value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Fixed-length ring of samples for live charts. Keeping the window bounded is
 * what stops an all-day console tab from growing without limit.
 */
export function useLiveSeries<T extends Record<string, number>>(
  sample: T | null,
  maxPoints = 60,
): (T & { t: string })[] {
  const [points, setPoints] = React.useState<(T & { t: string })[]>([]);

  React.useEffect(() => {
    if (!sample) return;
    setPoints((current) => {
      const next = [...current, { ...sample, t: new Date().toISOString() }];
      return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
    });
  }, [sample, maxPoints]);

  return points;
}
