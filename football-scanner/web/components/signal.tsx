import { cn } from '@/lib/utils';
import { NA, RANK_META, RISK_META, pct, signedPct, valueTone } from '@/lib/format';
import type { Rank, RiskLevel } from '@/lib/types';

const pill =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide';

export function RankBadge({
  rank,
  compact = false,
  short = false,
}: {
  rank: Rank;
  compact?: boolean;
  short?: boolean;
}) {
  const meta = RANK_META[rank] ?? RANK_META.NO_VALUE;
  return (
    <span className={cn(pill, meta.className)} title={meta.label}>
      <span aria-hidden>{meta.icon}</span>
      {!compact && (short ? meta.short : meta.label)}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: RiskLevel | null }) {
  if (!risk) return <span className="text-xs text-muted-foreground">{NA}</span>;
  return <span className={cn(pill, RISK_META[risk])}>{risk}</span>;
}

export function ProbBar({ value, className }: { value: number | null; className?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">{NA}</span>;
  }
  const w = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={cn('flex min-w-[96px] items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${w}%` }} />
      </div>
      <span className="num w-12 text-right text-xs font-medium">{pct(value)}</span>
    </div>
  );
}

export function ValueText({ value }: { value: number | null }) {
  return <span className={cn('num font-semibold', valueTone(value))}>{signedPct(value)}</span>;
}

export function ConfidenceMeter({ value }: { value: number | null }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">{NA}</span>;
  }
  const tone =
    value >= 75 ? 'bg-signal-best' : value >= 55 ? 'bg-signal-moderate' : 'bg-signal-avoid';
  return (
    <div className="flex items-center gap-2" title="Confidence in the inputs — not a probability">
      <div className="flex gap-0.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn('h-2.5 w-1.5 rounded-sm', value >= (i + 1) * 20 - 10 ? tone : 'bg-muted')}
          />
        ))}
      </div>
      <span className="num text-xs font-medium">{value}/100</span>
    </div>
  );
}
