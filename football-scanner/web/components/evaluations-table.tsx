'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';

import { ConfidenceMeter, ProbBar, RankBadge, RiskBadge, ValueText } from '@/components/signal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NA, kickoff, odds, pct, pp, signedPct } from '@/lib/format';
import type { Evaluation, ScanResult } from '@/lib/types';
import { cn } from '@/lib/utils';

type Row = Evaluation & Partial<ScanResult>;
type SortKey = 'value_pct' | 'probability' | 'confidence' | 'odds' | 'edge_pp' | 'rank' | 'kickoff';

const RANK_ORDER: Record<string, number> = {
  BEST_VALUE: 0,
  STRONG_VALUE: 1,
  MODERATE_VALUE: 2,
  NO_VALUE: 3,
  AVOID: 4,
  INSUFFICIENT_DATA: 5,
};

function sortValue(r: Row, key: SortKey): number {
  switch (key) {
    case 'rank':
      return -(RANK_ORDER[r.rank] ?? 9);
    case 'kickoff':
      return r.kickoff ? -new Date(r.kickoff).getTime() : 0;
    default: {
      const v = r[key];
      return typeof v === 'number' ? v : -Infinity;
    }
  }
}

const COMPONENT_LABELS: Record<string, string> = {
  data_quality: 'Data quality',
  sample_size: 'Sample size',
  model_agreement: 'Model agreement',
  form: 'Form stability',
  squad: 'Squad availability',
  market_consistency: 'Market consistency',
  statistical_stability: 'Statistical stability',
};

function Details({ r }: { r: Row }) {
  return (
    <div className="grid gap-4 p-3 text-xs sm:grid-cols-3">
      <div className="space-y-1">
        <div className="font-semibold uppercase tracking-wide text-muted-foreground">Pricing</div>
        <Line k="Model probability" v={pct(r.probability, 2)} />
        {r.push_probability ? (
          <Line k="Push / refund chance" v={pct(r.push_probability, 1)} />
        ) : null}
        <Line k="Fair odds" v={odds(r.fair_odds)} />
        <Line k="Best odds" v={`${odds(r.odds)}${r.bookmaker ? ` · ${r.bookmaker}` : ''}`} />
        <Line k="Implied (1/odds)" v={pct(r.implied_probability, 2)} />
        <Line k="Market (no-vig)" v={pct(r.no_vig_probability, 2)} />
        <Line k="Edge" v={pp(r.edge_pp)} />
        <Line k="Expected value" v={signedPct(r.value_pct, 2)} />
        <Line k="Bookmakers" v={r.bookmakers ? String(r.bookmakers) : NA} />
        <Line
          k="Odds movement"
          v={
            r.movement_pct === null
              ? NA
              : `${odds(r.opening_odds)} → ${odds(r.odds)} (${signedPct(r.movement_pct)})`
          }
        />
      </div>
      <div className="space-y-1">
        <div className="font-semibold uppercase tracking-wide text-muted-foreground">
          Confidence {r.confidence ?? NA}/100
        </div>
        {Object.entries(r.confidence_components || {}).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-36 text-muted-foreground">{COMPONENT_LABELS[k] ?? k}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary/70" style={{ width: `${v * 100}%` }} />
            </div>
            <span className="num w-8 text-right">{Math.round(v * 100)}</span>
          </div>
        ))}
        {r.model_spread !== null && r.model_spread !== undefined && (
          <Line k="Spread across models" v={pct(r.model_spread, 1)} />
        )}
        <p className="pt-1 text-[11px] text-muted-foreground">
          Confidence rates the inputs. It is not a probability of winning.
        </p>
      </div>
      <div className="space-y-1">
        <div className="font-semibold uppercase tracking-wide text-muted-foreground">
          Risk factors
        </div>
        {r.risk_factors?.length ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {r.risk_factors.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None flagged.</p>
        )}
        {r.rank_note && <p className="pt-1 text-signal-moderate">{r.rank_note}</p>}
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="num text-right font-medium">{v}</span>
    </div>
  );
}

export function EvaluationsTable({
  rows,
  showMatch = false,
  empty = 'No selections.',
  initialSort = 'rank',
}: {
  rows: Row[];
  showMatch?: boolean;
  empty?: React.ReactNode;
  initialSort?: SortKey;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: initialSort,
    desc: true,
  });
  const [open, setOpen] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const d = sortValue(b, sort.key) - sortValue(a, sort.key);
      if (d !== 0 && Number.isFinite(d)) return sort.desc ? d : -d;
      return (b.value_pct ?? -1e9) - (a.value_pct ?? -1e9);
    });
    return copy;
  }, [rows, sort]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }

  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
      >
        {label}
        {sort.key === key &&
          (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </TableHead>
  );

  const rowId = (r: Row) => `${r.fixture_id ?? ''}:${r.key}`;

  return (
    <>
      {/* Phones: stacked cards */}
      <div className="space-y-2 md:hidden">
        {sorted.map((r) => {
          const id = rowId(r);
          return (
            <div key={id} className="rounded-lg border bg-card p-3">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setOpen(open === id ? null : id)}
              >
                {showMatch && r.fixture_id && (
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="truncate">{r.match}</span>
                    {r.kickoff && <span className="num">{kickoff(r.kickoff)}</span>}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {r.market_label}
                    </div>
                    <div className="font-semibold">{r.label}</div>
                  </div>
                  <RankBadge rank={r.rank} short />
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                  <Mini k="Odds" v={odds(r.odds)} />
                  <Mini k="Prob" v={pct(r.probability)} />
                  <Mini k="Fair" v={odds(r.fair_odds)} />
                  <Mini k="Value" v={<ValueText value={r.value_pct} />} />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <ConfidenceMeter value={r.confidence} />
                  <RiskBadge risk={r.risk} />
                </div>
              </button>
              {open === id && (
                <div className="mt-2 border-t">
                  <Details r={r} />
                  {showMatch && r.fixture_id && (
                    <Link
                      href={`/matches/${r.fixture_id}`}
                      className="block px-3 pb-2 text-xs font-medium text-primary"
                    >
                      Open match →
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tablets and up: table */}
      <div className="hidden rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-6" />
              {showMatch && head('kickoff', 'Match')}
              <TableHead>Market</TableHead>
              {head('odds', 'Odds', 'text-right')}
              {head('probability', 'Probability')}
              <TableHead className="text-right">Fair</TableHead>
              {head('edge_pp', 'Edge', 'text-right')}
              {head('value_pct', 'Value', 'text-right')}
              {head('confidence', 'Confidence')}
              <TableHead>Risk</TableHead>
              {head('rank', 'Signal')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => {
              const id = rowId(r);
              const expanded = open === id;
              return (
                <Fragment key={id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setOpen(expanded ? null : id)}
                  >
                    <TableCell className="pr-0 text-muted-foreground">
                      {expanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    {showMatch && (
                      <TableCell className="max-w-[260px]">
                        {r.fixture_id ? (
                          <Link
                            href={`/matches/${r.fixture_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate font-medium hover:text-primary"
                          >
                            {r.match}
                          </Link>
                        ) : null}
                        <div className="truncate text-[11px] text-muted-foreground">
                          {r.kickoff ? kickoff(r.kickoff) : ''} · {r.league ?? NA}
                        </div>
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="font-medium">{r.label}</div>
                      <div className="text-[11px] text-muted-foreground">{r.market_label}</div>
                    </TableCell>
                    <TableCell className="num text-right font-semibold">{odds(r.odds)}</TableCell>
                    <TableCell>
                      <ProbBar value={r.probability} />
                    </TableCell>
                    <TableCell className="num text-right">{odds(r.fair_odds)}</TableCell>
                    <TableCell
                      className={cn(
                        'num text-right text-xs',
                        (r.edge_pp ?? 0) > 0 ? 'text-signal-strong' : 'text-muted-foreground',
                      )}
                    >
                      {pp(r.edge_pp, 1)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ValueText value={r.value_pct} />
                    </TableCell>
                    <TableCell>
                      <ConfidenceMeter value={r.confidence} />
                    </TableCell>
                    <TableCell>
                      <RiskBadge risk={r.risk} />
                    </TableCell>
                    <TableCell>
                      <RankBadge rank={r.rank} short />
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={showMatch ? 11 : 10} className="whitespace-normal p-0">
                        <Details r={r} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function Mini({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="num font-semibold">{v}</div>
    </div>
  );
}
