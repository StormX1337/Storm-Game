'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Radar, Save } from 'lucide-react';

import { Disclaimer, Notice, PageHeader } from '@/components/common';
import { EvaluationsTable } from '@/components/evaluations-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { post, put, todayISO, userTimeZone } from '@/lib/api';
import type { Filters, Meta, RiskLevel, ScanResult } from '@/lib/types';

interface ScanResponse {
  scanned_matches: number;
  analysed_matches: number;
  results: ScanResult[];
  total: number;
}

const RISKS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'];

export default function ScannerPage() {
  const { data: meta } = useSWR<Meta>('/api/meta');
  const { data: defaults } = useSWR<Filters>('/api/scanner/defaults');
  // Today is the viewer's local date, so it is set in the browser, not at build time.
  const [date, setDate] = useState('');
  useEffect(() => setDate(todayISO()), []);
  const [league, setLeague] = useState('');
  const [country, setCountry] = useState('');
  const [market, setMarket] = useState('');
  const [filters, setFilters] = useState<Filters>({
    min_probability: 0.65,
    min_value: 8,
    max_risk: 'MEDIUM',
    min_confidence: 70,
  });
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (defaults) setFilters(defaults);
  }, [defaults]);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await post<ScanResponse>('/api/scanner/scan', {
          date,
          tz: userTimeZone(),
          league_ids: league ? [Number(league)] : [],
          countries: country ? [country] : [],
          markets: market ? [market] : [],
          ...filters,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveDefaults() {
    await put('/api/scanner/defaults', filters);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <>
      <PageHeader
        title="Automatic scanner"
        subtitle="Scans every analysed match and returns only the selections that meet your conditions."
      />
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Country">
            <Select value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              {meta?.countries.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="League">
            <Select value={league} onChange={(e) => setLeague(e.target.value)}>
              <option value="">All enabled leagues</option>
              {meta?.leagues
                .filter((l) => !country || l.country === country)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.country ? `${l.country} — ` : ''}
                    {l.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Market">
            <Select value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value="">All markets</option>
              <optgroup label="Groups">
                {meta?.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Markets">
                {meta?.markets
                  .filter((m) => m.enabled)
                  .map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
              </optgroup>
            </Select>
          </Field>
          <Field label="Minimum probability (%)">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(filters.min_probability * 100)}
              onChange={(e) =>
                set('min_probability', Math.min(100, Math.max(0, Number(e.target.value))) / 100)
              }
            />
          </Field>
          <Field label="Minimum value (%)">
            <Input
              type="number"
              step={0.5}
              value={filters.min_value}
              onChange={(e) => set('min_value', Number(e.target.value))}
            />
          </Field>
          <Field label="Minimum confidence (0–100)">
            <Input
              type="number"
              min={0}
              max={100}
              value={filters.min_confidence}
              onChange={(e) =>
                set('min_confidence', Math.min(100, Math.max(0, Number(e.target.value))))
              }
            />
          </Field>
          <Field label="Maximum risk">
            <Select
              value={filters.max_risk}
              onChange={(e) => set('max_risk', e.target.value as RiskLevel)}
            >
              {RISKS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
            <Button onClick={scan} disabled={busy}>
              <Radar /> {busy ? 'Scanning…' : 'Scan'}
            </Button>
            <Button variant="outline" onClick={saveDefaults}>
              <Save /> {saved ? 'Saved' : 'Save as my defaults'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="mt-5 space-y-3">
        {error && <Notice tone="warn">{error}</Notice>}
        {result && (
          <>
            <p className="text-sm text-muted-foreground">
              {result.total} selection{result.total === 1 ? '' : 's'} matched across{' '}
              {result.analysed_matches} analysed of {result.scanned_matches} scheduled matches.
            </p>
            <EvaluationsTable
              rows={result.results}
              showMatch
              initialSort="value_pct"
              empty="Nothing meets these conditions. Loosen the filters or pick another date."
            />
          </>
        )}
      </div>
      <Disclaimer />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
