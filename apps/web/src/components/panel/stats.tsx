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
 * The chip carries the tone, and the ordinary tone is no chip at all.
 *
 * Tinting `default` was the first mistake: on the server overview every card
 * is `default` almost all of the time, so four identical blue squares marched
 * across the top competing with the figures beside them. Colour that appears
 * on everything cannot single anything out — which was the entire argument
 * for putting it there.
 *
 * Making it grey said the right thing in the wrong material. The box is the
 * carrier for a colour that is usually absent, so on almost every card it was
 * carrying nothing: thirty-six pixels of bordered grey with a dim glyph in
 * the middle, which is the shape of a disabled button, four across the top of
 * a page. The figures are what the card is for, and they were sharing the
 * width with four of those.
 *
 * So the box goes when the colour does. The icon stays — it is how you find
 * the memory card without reading — and a card that does have something to
 * report is then the only one wearing a chip, which is what a chip is for.
 */
const TONE_CHIP: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-muted-foreground/70',
  success: 'border border-success/25 bg-success/12 text-success',
  warning: 'border border-warning/25 bg-warning/12 text-warning',
  destructive: 'border border-destructive/25 bg-destructive/12 text-destructive',
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
          {/* Wraps rather than truncates. The value above is a figure and may
              be clipped without losing its sense; the hint is a sentence, and
              "Average across onl…" is not a shorter way of saying anything.
              These sit in a grid row, so the extra line lifts every card in
              the row together and the tops still align. */}
          {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
        </div>

        {Icon ? (
          // The same 36px of corner either way, so a card that gains a tone
          // does not change height or shove its figures sideways — only the
          // chip appears around the icon that was already there.
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              TONE_CHIP[tone],
            )}
          >
            <Icon className="h-5 w-5" />
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
  showPercent = true,
  className,
}: {
  label: string;
  used: number;
  limit: number;
  formatValue: (value: number) => string;
  icon?: React.ComponentType<{ className?: string }>;
  /**
   * Off when the values are themselves percentages — a CPU meter reading
   * "0% · 0% / 200%" makes a reader work out which percent is of what, and
   * the answer is that the first is redundant.
   */
  showPercent?: boolean;
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
        {/* The label gives way, never the figures: squeezed into a narrow
            card the row used to break "0 B / 84 GiB" across five lines, one
            fragment each, which is not a smaller way of showing a number. */}
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
          <span className="truncate">{label}</span>
        </span>
        {/*
          One line, not two.

          This used to end with a right-aligned "0% used" caption under the
          bar, which made every meter three rows tall to carry two rows of
          idea — the bar is already the percentage, drawn to scale, and the
          figures above it are already the amounts. Stacked three deep, four
          meters filled a card with a fact stated three times.

          The number itself stays: at 1.4 of 2 GiB nobody wants to do the
          division, and it is the number the colour shift is keyed to. It just
          does not need a row of its own.
        */}
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {!unlimited && showPercent ? (
            <span className="font-medium">{formatPercent(percent, 0)}</span>
          ) : null}
          <span className={cn(!unlimited && showPercent ? 'text-muted-foreground' : 'font-medium')}>
            {!unlimited && showPercent ? ' · ' : null}
            {formatValue(used)}
            <span className="text-muted-foreground">
              {unlimited ? ' / unlimited' : ` / ${formatValue(limit)}`}
            </span>
          </span>
        </span>
      </div>
      <Progress value={percent} indicatorClassName={tone} />
    </div>
  );
}
