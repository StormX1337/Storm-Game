import Link from 'next/link';
import { AlertTriangle, Info } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { DataStatus } from '@/lib/types';

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight md:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const color = {
    default: 'text-foreground',
    good: 'text-signal-best',
    warn: 'text-signal-moderate',
    bad: 'text-signal-avoid',
  }[tone ?? 'default'];
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className={cn('num mt-1 text-2xl font-bold md:text-3xl', color)}>{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn';
  children: React.ReactNode;
}) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-sm',
        tone === 'warn'
          ? 'border-signal-moderate/30 bg-signal-moderate/10'
          : 'border-border bg-muted/40',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'warn' ? 'text-signal-moderate' : 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

export function DataStatusNotice({ status, admin }: { status?: DataStatus; admin: boolean }) {
  if (!status) return null;
  const problems: string[] = [];
  if (!status.football_api_configured) problems.push('No football data API key is configured.');
  if (!status.odds_api_configured) problems.push('No odds API key is configured.');
  if (status.enabled_leagues === 0) problems.push('No leagues are enabled for scanning.');
  if (problems.length === 0) return null;
  return (
    <Notice tone="warn">
      <p className="font-medium">Data sources are not fully configured.</p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {admin ? (
        <p>
          Configure keys and leagues in{' '}
          <Link
            href="/admin"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Admin
          </Link>
          . Until then every statistic shows N/A — nothing is simulated.
        </p>
      ) : (
        <p className="text-muted-foreground">Ask an administrator to configure data sources.</p>
      )}
    </Notice>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Disclaimer() {
  return (
    <p className="mt-8 text-[11px] leading-relaxed text-muted-foreground">
      Probabilities come from a statistical model and can be wrong. Value labels grade the quality
      of a statistical signal; they are not tips, do not indicate that any match is arranged, and
      never guarantee profit. Bet only what you can afford to lose.
    </p>
  );
}
