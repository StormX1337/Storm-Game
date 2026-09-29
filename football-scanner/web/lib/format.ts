import type { Rank, RiskLevel } from './types';

export const NA = 'N/A';

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NA;
  return `${(v * 100).toFixed(digits)}%`;
}

export function signedPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NA;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function pp(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return NA;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} pp`;
}

export function odds(v: number | null | undefined): string {
  if (v === null || v === undefined) return NA;
  return v.toFixed(2);
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NA;
  return v.toFixed(digits);
}

export function units(v: number | null | undefined): string {
  if (v === null || v === undefined) return NA;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}u`;
}

export function kickoff(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  return new Date(iso).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
}

export const RANK_META: Record<
  Rank,
  { label: string; short: string; icon: string; className: string }
> = {
  BEST_VALUE: {
    label: 'Best value',
    short: 'Best',
    icon: '🔥',
    className: 'bg-signal-best/15 text-signal-best border-signal-best/30',
  },
  STRONG_VALUE: {
    label: 'Strong value',
    short: 'Strong',
    icon: '🟢',
    className: 'bg-signal-strong/15 text-signal-strong border-signal-strong/30',
  },
  MODERATE_VALUE: {
    label: 'Moderate value',
    short: 'Moderate',
    icon: '🟡',
    className: 'bg-signal-moderate/15 text-signal-moderate border-signal-moderate/30',
  },
  NO_VALUE: {
    label: 'No value',
    short: 'None',
    icon: '⚪',
    className: 'bg-signal-none/10 text-signal-none border-signal-none/25',
  },
  AVOID: {
    label: 'Avoid',
    short: 'Avoid',
    icon: '🔴',
    className: 'bg-signal-avoid/15 text-signal-avoid border-signal-avoid/30',
  },
  INSUFFICIENT_DATA: {
    label: 'Insufficient data',
    short: 'No data',
    icon: '⚠',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

export const RISK_META: Record<RiskLevel, string> = {
  LOW: 'bg-risk-low/15 text-risk-low border-risk-low/30',
  MEDIUM: 'bg-risk-medium/15 text-risk-medium border-risk-medium/30',
  HIGH: 'bg-risk-high/15 text-risk-high border-risk-high/30',
  'VERY HIGH': 'bg-risk-vhigh/15 text-risk-vhigh border-risk-vhigh/30',
};

export function valueTone(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-muted-foreground';
  if (v >= 10) return 'text-signal-best';
  if (v >= 5) return 'text-signal-strong';
  if (v >= 2) return 'text-signal-moderate';
  if (v <= -10) return 'text-signal-avoid';
  return 'text-muted-foreground';
}

export const STATUS_LABEL: Record<string, string> = {
  NS: 'Scheduled',
  TBD: 'TBD',
  '1H': '1st half',
  HT: 'Half-time',
  '2H': '2nd half',
  ET: 'Extra time',
  P: 'Penalties',
  FT: 'Full-time',
  AET: 'After ET',
  PEN: 'After pens',
  PST: 'Postponed',
  CANC: 'Cancelled',
  ABD: 'Abandoned',
};

export const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
