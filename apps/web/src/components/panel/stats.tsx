'use client';

import * as React from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Badge, Card, Progress, Skeleton, cn } from '@storm/ui';
import type { NodeStatus, ServerStatus } from '@storm/types';
import {
  NODE_STATUS_META,
  SERVER_STATUS_META,
  formatPercent,
  usagePercent,
  type StatusTone,
} from '@/lib/format';

/* ------------------------------------------------------------ status dot -- */

const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
  default: 'bg-primary',
};

const TONE_BADGE: Record<StatusTone, 'success' | 'warning' | 'destructive' | 'muted' | 'default'> =
  {
    success: 'success',
    warning: 'warning',
    destructive: 'destructive',
    muted: 'muted',
    default: 'default',
  };

export function ServerStatusBadge({
  status,
  className,
}: {
  status: ServerStatus;
  className?: string;
}) {
  const meta = SERVER_STATUS_META[status] ?? { label: status, tone: 'muted' as StatusTone };
  return (
    <Badge variant={TONE_BADGE[meta.tone]} className={className}>
      <span
        className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[meta.tone])}
        style={meta.pulse ? { animation: 'storm-pulse 1.6s ease-in-out infinite' } : undefined}
      />
      {meta.label}
    </Badge>
  );
}

export function NodeStatusBadge({ status, className }: { status: NodeStatus; className?: string }) {
  const meta = NODE_STATUS_META[status] ?? { label: status, tone: 'muted' as StatusTone };
  return (
    <Badge variant={TONE_BADGE[meta.tone]} className={className}>
      <span
        className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[meta.tone])}
        style={meta.pulse ? { animation: 'storm-pulse 1.6s ease-in-out infinite' } : undefined}
      />
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------- stat card -- */

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  trend?: { value: number; label?: string };
  tone?: 'default' | 'success' | 'warning' | 'destructive';
  loading?: boolean;
  className?: string;
}

/**
 * The chip carries the tone, and the ordinary tone is no colour at all.
 *
 * Tinting `default` was a mistake: on the server overview every card is
 * `default` almost all of the time, so four identical blue squares marched
 * across the top competing with the figures beside them. Colour that appears
 * on everything cannot single anything out — which was the entire argument
 * for putting it there.
 */
const TONE_CHIP: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'border-border bg-secondary/50 text-muted-foreground',
  success: 'border-success/25 bg-success/12 text-success',
  warning: 'border-warning/25 bg-warning/12 text-warning',
  destructive: 'border-destructive/25 bg-destructive/12 text-destructive',
};

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  trend,
  tone = 'default',
  loading,
  className,
}: StatCardProps) {
  return (
    <Card className={cn('relative overflow-hidden p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <p
              className={cn(
                'truncate text-2xl font-semibold tracking-tight tabular-nums',
                tone === 'success' && 'text-success',
                tone === 'warning' && 'text-warning',
                tone === 'destructive' && 'text-destructive',
              )}
            >
              {value}
            </p>
          )}
          {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>

        {Icon ? (
          // Tinted with the figure's own tone rather than left grey: on a
          // wall of stat cards the colour is what tells you which one is the
          // one in trouble, before you have read a single number.
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
              TONE_CHIP[tone],
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
      </div>

      {trend ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          {trend.value >= 0 ? (
            <TrendingUp className="h-3.5 w-3.5 text-success" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className={trend.value >= 0 ? 'text-success' : 'text-destructive'}>
            {trend.value >= 0 ? '+' : ''}
            {trend.value.toFixed(1)}%
          </span>
          {trend.label ? <span className="text-muted-foreground">{trend.label}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------- usage bar -- */

export function UsageMeter({
  label,
  used,
  limit,
  formatValue,
  icon: Icon,
  className,
}: {
  label: string;
  used: number;
  limit: number;
  formatValue: (value: number) => string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  const percent = usagePercent(used, limit);
  const unlimited = !limit || limit <= 0;

  // Colour only shifts once usage is genuinely worth attention. The glow is
  // named per tone rather than taken from `currentColor`: the bar sets a
  // background, not a text colour, so `currentColor` there would be whatever
  // the surrounding paragraph happened to be.
  const tone =
    percent >= 90
      ? 'bg-destructive shadow-[0_0_10px_-1px_hsl(var(--destructive)/0.7)]'
      : percent >= 75
        ? 'bg-warning shadow-[0_0_10px_-1px_hsl(var(--warning)/0.7)]'
        : 'bg-primary shadow-[0_0_10px_-1px_hsl(var(--primary)/0.7)]';

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          {label}
        </span>
        <span className="font-medium tabular-nums">
          {formatValue(used)}
          {unlimited ? (
            <span className="text-muted-foreground"> / unlimited</span>
          ) : (
            <span className="text-muted-foreground"> / {formatValue(limit)}</span>
          )}
        </span>
      </div>
      <Progress value={percent} indicatorClassName={tone} />
      {!unlimited ? (
        <p className="text-right text-2xs text-muted-foreground">
          {formatPercent(percent, 0)} used
        </p>
      ) : null}
    </div>
  );
}
