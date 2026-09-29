'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Calculator } from 'lucide-react';

import { Notice, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { post } from '@/lib/api';
import { pct } from '@/lib/format';

type Method = 'fixed' | 'percentage' | 'kelly' | 'half_kelly';

interface Recommendation {
  method: Method;
  stake: number;
  fraction_of_bankroll: number;
  uncapped_stake: number;
  capped: boolean;
  note: string | null;
  policy: string;
}

const METHODS: { value: Method; label: string; hint: string }[] = [
  {
    value: 'half_kelly',
    label: 'Half Kelly (default)',
    hint: 'Half the Kelly fraction — less volatile than full Kelly.',
  },
  {
    value: 'kelly',
    label: 'Kelly',
    hint: 'Growth-optimal if the probability is exactly right; very volatile.',
  },
  {
    value: 'percentage',
    label: 'Percentage stake',
    hint: 'A fixed share of the bankroll per bet.',
  },
  { value: 'fixed', label: 'Fixed stake', hint: 'The same amount on every bet.' },
];

export default function BankrollPage() {
  const { data: defaults } =
    useSWR<Record<string, number | string | null>>('/api/bankroll/defaults');
  const [bankroll, setBankroll] = useState(5000);
  const [method, setMethod] = useState<Method>('half_kelly');
  const [percent, setPercent] = useState(1);
  const [fixed, setFixed] = useState(50);
  const [probability, setProbability] = useState(60);
  const [oddsValue, setOdds] = useState(1.9);
  const [cap, setCap] = useState(2);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!defaults) return;
    if (typeof defaults.bankroll === 'number') setBankroll(defaults.bankroll);
    if (typeof defaults.method === 'string') setMethod(defaults.method as Method);
    if (typeof defaults.percent === 'number') setPercent(defaults.percent);
    if (typeof defaults.fixed_amount === 'number') setFixed(defaults.fixed_amount);
    if (typeof defaults.cap_percent === 'number') setCap(defaults.cap_percent);
  }, [defaults]);

  async function calculate() {
    setError(null);
    try {
      setRec(
        await post<Recommendation>('/api/bankroll/calculate', {
          bankroll,
          method,
          percent: method === 'percentage' ? percent : null,
          fixed_amount: method === 'fixed' ? fixed : null,
          probability: method.includes('kelly') ? probability / 100 : null,
          odds: method.includes('kelly') ? oddsValue : null,
          cap_percent: cap,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Calculation failed');
    }
  }

  const kelly = method === 'kelly' || method === 'half_kelly';
  return (
    <>
      <PageHeader title="Bankroll" subtitle="Stake sizing. Stakes never increase after a loss." />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Bankroll (€)">
              <Input
                type="number"
                min={1}
                value={bankroll}
                onChange={(e) => setBankroll(Number(e.target.value))}
              />
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            {method === 'percentage' && (
              <Field label="Risk per bet (%)">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={percent}
                  onChange={(e) => setPercent(Number(e.target.value))}
                />
              </Field>
            )}
            {method === 'fixed' && (
              <Field label="Stake (€)">
                <Input
                  type="number"
                  min={0}
                  value={fixed}
                  onChange={(e) => setFixed(Number(e.target.value))}
                />
              </Field>
            )}
            {kelly && (
              <>
                <Field label="Model probability (%)">
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    step={0.1}
                    value={probability}
                    onChange={(e) => setProbability(Number(e.target.value))}
                  />
                </Field>
                <Field label="Odds">
                  <Input
                    type="number"
                    min={1.01}
                    step={0.01}
                    value={oddsValue}
                    onChange={(e) => setOdds(Number(e.target.value))}
                  />
                </Field>
              </>
            )}
            <Field label="Maximum stake (% of bankroll)">
              <Input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
            </Field>
            <div className="flex items-end">
              <Button onClick={calculate} className="w-full sm:w-auto">
                <Calculator /> Calculate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {METHODS.find((m) => m.value === method)?.hint}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recommended stake</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {error && <Notice tone="warn">{error}</Notice>}
            {rec ? (
              <>
                <div className="num text-4xl font-bold text-primary">
                  €{rec.stake.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div className="text-sm text-muted-foreground">
                  {pct(rec.fraction_of_bankroll, 2)} of bankroll
                </div>
                {rec.capped && (
                  <p className="text-sm text-signal-moderate">
                    Capped at {cap}% (uncapped: €{rec.uncapped_stake.toFixed(2)}).
                  </p>
                )}
                {rec.note && <p className="text-sm">{rec.note}</p>}
                <p className="pt-2 text-[11px] text-muted-foreground">{rec.policy}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Enter your figures and press Calculate.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
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
