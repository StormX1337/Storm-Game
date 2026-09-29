'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Play, RefreshCw, Save } from 'lucide-react';

import { Empty, Notice } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { patch, post, put } from '@/lib/api';
import { NA, dateTime, num, odds, pct, units } from '@/lib/format';
import type { Meta, Performance } from '@/lib/types';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------------ system

interface Job {
  name: string;
  description: string;
  interval_minutes: number | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  last_message: string | null;
  requested: boolean;
}

export function SystemPanel() {
  const { data, mutate } = useSWR<Record<string, number | Job[]>>('/api/admin/overview', {
    refreshInterval: 15_000,
  });
  const jobs = (data?.jobs as Job[] | undefined) ?? [];
  async function run(name: string) {
    await post(`/api/admin/jobs/${name}/run`);
    mutate();
  }
  const tiles: [string, string][] = [
    ['users', 'Users'],
    ['leagues_enabled', 'Leagues enabled'],
    ['fixtures', 'Fixtures stored'],
    ['analysed_fixtures', 'Analysed fixtures'],
    ['odds_snapshots', 'Price changes'],
    ['signals', 'Signals'],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([k, label]) => (
          <Card key={k}>
            <CardContent className="p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {label}
              </div>
              <div className="num text-xl font-bold">{String(data?.[k] ?? '—')}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Background jobs</CardTitle>
          <CardDescription>
            The worker runs each job on its interval. “Run now” queues it for the next tick.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Job</TableHead>
                <TableHead>Every</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Message</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.name}>
                  <TableCell>
                    <div className="font-medium">{j.name}</div>
                    <div className="text-[11px] text-muted-foreground">{j.description}</div>
                  </TableCell>
                  <TableCell className="num">{j.interval_minutes} min</TableCell>
                  <TableCell className="text-xs">
                    {dateTime(j.last_finished_at ?? j.last_started_at)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        j.last_status === 'ok'
                          ? 'default'
                          : j.last_status === 'error'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {j.requested ? 'queued' : (j.last_status ?? 'never run')}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-[360px] truncate text-xs text-muted-foreground"
                    title={j.last_message ?? ''}
                  >
                    {j.last_message ?? ''}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => run(j.name)}
                      disabled={j.requested}
                    >
                      <Play /> Run now
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ API keys

interface KeyRow {
  provider: string;
  description: string;
  configured: boolean;
  source: string | null;
  masked: string | null;
  updated_at: string | null;
}

export function KeysPanel() {
  const { data, mutate } = useSWR<KeyRow[]>('/api/admin/api-keys');
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  async function save(provider: string, key: string | null) {
    await put('/api/admin/api-keys', { provider, key });
    setValues((v) => ({ ...v, [provider]: '' }));
    setMessage(key ? 'Key saved (stored encrypted).' : 'Key removed.');
    mutate();
  }
  return (
    <div className="space-y-3">
      {message && <Notice>{message}</Notice>}
      {data?.map((k) => (
        <Card key={k.provider}>
          <CardHeader>
            <CardTitle>{k.provider}</CardTitle>
            <CardDescription>{k.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={k.configured ? 'default' : 'destructive'}>
                {k.configured ? 'configured' : 'missing'}
              </Badge>
              {k.source && <span className="text-muted-foreground">source: {k.source}</span>}
              {k.masked && (
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.masked}</code>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                autoComplete="off"
                placeholder="Paste a new key"
                value={values[k.provider] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [k.provider]: e.target.value }))}
              />
              <Button
                onClick={() => save(k.provider, values[k.provider] || null)}
                disabled={!values[k.provider]}
              >
                <Save /> Save
              </Button>
              {k.source === 'admin' && (
                <Button variant="outline" onClick={() => save(k.provider, null)}>
                  Remove
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        Keys entered here override environment variables and are encrypted at rest with the server
        secret.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ leagues

interface LeagueRow {
  id: number;
  name: string;
  country: string | null;
  type: string | null;
  season: number | null;
  enabled: boolean;
  odds_key: string | null;
}

export function LeaguesPanel() {
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (onlyEnabled) qs.set('enabled', 'true');
  const { data, mutate } = useSWR<LeagueRow[]>(`/api/admin/leagues?${qs}`);
  const { data: sports } = useSWR<{ key: string; title: string; group?: string }[]>(
    '/api/admin/odds-sports',
    {
      shouldRetryOnError: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshCatalogue() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/admin/leagues/sync');
      mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }
  async function update(id: number, body: Partial<LeagueRow>) {
    await patch(`/api/admin/leagues/${id}`, body);
    mutate();
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search league or country"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-64"
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={onlyEnabled} onCheckedChange={setOnlyEnabled} /> Enabled only
        </label>
        <Button variant="outline" onClick={refreshCatalogue} disabled={busy}>
          <RefreshCw className={busy ? 'animate-spin' : ''} /> Load league catalogue
        </Button>
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {!data || data.length === 0 ? (
        <Empty>
          No leagues stored. Configure the API-Football key, then load the league catalogue.
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Scan</TableHead>
                <TableHead>League</TableHead>
                <TableHead>Season</TableHead>
                <TableHead>Odds mapping (The Odds API)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Switch
                      checked={l.enabled}
                      onCheckedChange={(v) => update(l.id, { enabled: v })}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{l.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {l.country ?? NA} · {l.type ?? ''} · id {l.id}
                    </div>
                  </TableCell>
                  <TableCell className="num">{l.season ?? NA}</TableCell>
                  <TableCell>
                    {sports && sports.length > 0 ? (
                      <Select
                        value={l.odds_key ?? ''}
                        onChange={(e) => update(l.id, { odds_key: e.target.value || null })}
                        className="w-64"
                      >
                        <option value="">Not mapped</option>
                        {sports.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.title} ({s.key})
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        defaultValue={l.odds_key ?? ''}
                        placeholder="e.g. soccer_epl"
                        className="w-48"
                        onBlur={(e) =>
                          e.target.value !== (l.odds_key ?? '') &&
                          update(l.id, { odds_key: e.target.value || null })
                        }
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only enabled leagues are synced and analysed. When odds come from The Odds API each league
        needs its competition key; with API-Football odds no mapping is needed.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ settings

type Settings = Record<string, Record<string, unknown>>;

function useSettings() {
  return useSWR<Settings>('/api/admin/settings');
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  hint,
}: {
  label: string;
  value: unknown;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        step={step}
        value={String(value ?? '')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RiskField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={String(value ?? 'HIGH')} onChange={(e) => onChange(e.target.value)}>
        {['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'].map((r) => (
          <option key={r}>{r}</option>
        ))}
      </Select>
    </div>
  );
}

function SettingsForm({
  settingKey,
  title,
  description,
  render,
}: {
  settingKey: string;
  title: string;
  description?: string;
  render: (v: Record<string, unknown>, set: (k: string, val: unknown) => void) => React.ReactNode;
}) {
  const { data, mutate } = useSettings();
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data?.[settingKey]) setDraft(data[settingKey] as Record<string, unknown>);
  }, [data, settingKey]);
  if (!draft) return null;
  const set = (k: string, val: unknown) => setDraft((d) => ({ ...(d ?? {}), [k]: val }));
  async function save() {
    await put(`/api/admin/settings/${settingKey}`, draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    mutate();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{render(draft, set)}</div>
        <Button onClick={save}>
          <Save /> {saved ? 'Saved' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ThresholdsPanel() {
  return (
    <div className="space-y-4">
      <SettingsForm
        settingKey="signal_policy"
        title="Signal policy"
        description="Which evaluations are stored as signals and enter the track record."
        render={(v, set) => (
          <>
            <NumberField
              label="Minimum probability (0–1)"
              step={0.01}
              value={v.min_probability}
              onChange={(x) => set('min_probability', x)}
            />
            <NumberField
              label="Minimum value (%)"
              step={0.5}
              value={v.min_value}
              onChange={(x) => set('min_value', x)}
            />
            <NumberField
              label="Minimum confidence"
              value={v.min_confidence}
              onChange={(x) => set('min_confidence', x)}
            />
            <RiskField
              label="Maximum risk"
              value={v.max_risk}
              onChange={(x) => set('max_risk', x)}
            />
          </>
        )}
      />
      <SettingsForm
        settingKey="scanner_defaults"
        title="Scanner defaults"
        description="Pre-filled scanner filter for users who have not saved their own."
        render={(v, set) => (
          <>
            <NumberField
              label="Minimum probability (0–1)"
              step={0.01}
              value={v.min_probability}
              onChange={(x) => set('min_probability', x)}
            />
            <NumberField
              label="Minimum value (%)"
              step={0.5}
              value={v.min_value}
              onChange={(x) => set('min_value', x)}
            />
            <NumberField
              label="Minimum confidence"
              value={v.min_confidence}
              onChange={(x) => set('min_confidence', x)}
            />
            <RiskField
              label="Maximum risk"
              value={v.max_risk}
              onChange={(x) => set('max_risk', x)}
            />
          </>
        )}
      />
      <SettingsForm
        settingKey="thresholds"
        title="Value ranking"
        description="Labels grade the statistical signal, never a guaranteed outcome."
        render={(v, set) => (
          <>
            <NumberField
              label="🔥 Best: min value %"
              step={0.5}
              value={v.best_value}
              onChange={(x) => set('best_value', x)}
            />
            <NumberField
              label="🔥 Best: min confidence"
              value={v.best_confidence}
              onChange={(x) => set('best_confidence', x)}
            />
            <NumberField
              label="🟢 Strong: min value %"
              step={0.5}
              value={v.strong_value}
              onChange={(x) => set('strong_value', x)}
            />
            <NumberField
              label="🟢 Strong: min confidence"
              value={v.strong_confidence}
              onChange={(x) => set('strong_confidence', x)}
            />
            <NumberField
              label="🟡 Moderate: min value %"
              step={0.5}
              value={v.moderate_value}
              onChange={(x) => set('moderate_value', x)}
            />
            <NumberField
              label="🟡 Moderate: min confidence"
              value={v.moderate_confidence}
              onChange={(x) => set('moderate_confidence', x)}
            />
            <NumberField
              label="🔴 Avoid at value ≤ %"
              step={0.5}
              value={v.avoid_value}
              onChange={(x) => set('avoid_value', x)}
            />
            <NumberField
              label="Unreliable below confidence"
              value={v.unreliable_confidence}
              onChange={(x) => set('unreliable_confidence', x)}
            />
            <NumberField
              label="Implausible value above %"
              step={1}
              value={v.implausible_value}
              onChange={(x) => set('implausible_value', x)}
              hint="Treated as a likely data error."
            />
          </>
        )}
      />
      <SettingsForm
        settingKey="engine"
        title="Model"
        render={(v, set) => (
          <>
            <NumberField
              label="Min. matches per team"
              value={v.min_matches}
              onChange={(x) => set('min_matches', x)}
              hint="Below this: INSUFFICIENT DATA."
            />
            <NumberField
              label="Target matches (full confidence)"
              value={v.target_matches}
              onChange={(x) => set('target_matches', x)}
            />
            <NumberField
              label="Min. league matches for a baseline"
              value={v.min_league_matches}
              onChange={(x) => set('min_league_matches', x)}
            />
            <NumberField
              label="Dixon-Coles rho"
              step={0.01}
              value={v.dixon_coles_rho}
              onChange={(x) => set('dixon_coles_rho', x)}
            />
          </>
        )}
      />
      <SettingsForm
        settingKey="odds"
        title="Odds"
        render={(v, set) => (
          <>
            <div className="space-y-1.5">
              <Label>Odds source</Label>
              <Select value={String(v.source)} onChange={(e) => set('source', e.target.value)}>
                <option value="the_odds_api">The Odds API</option>
                <option value="api_football">API-Football</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Regions (The Odds API)</Label>
              <Input
                value={String(v.regions ?? '')}
                onChange={(e) => set('regions', e.target.value)}
              />
            </div>
            <NumberField
              label="Strong movement alert (%)"
              step={0.5}
              value={v.movement_alert_pct}
              onChange={(x) => set('movement_alert_pct', x)}
            />
            <NumberField
              label="Ignore prices older than (h)"
              step={0.5}
              value={v.max_snapshot_age_hours}
              onChange={(x) => set('max_snapshot_age_hours', x)}
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={Boolean(v.fetch_extra_markets)}
                onCheckedChange={(x) => set('fetch_extra_markets', x)}
              />
              Fetch extra markets (BTTS, corners, cards…)
            </label>
          </>
        )}
      />
      <SettingsForm
        settingKey="sync"
        title="Data refresh"
        render={(v, set) => (
          <>
            <NumberField
              label="Days ahead to scan"
              value={v.days_ahead}
              onChange={(x) => set('days_ahead', x)}
            />
            <NumberField
              label="History matches per team"
              value={v.history_matches}
              onChange={(x) => set('history_matches', x)}
            />
          </>
        )}
      />
    </div>
  );
}

export function MarketsPanel() {
  const { data: meta } = useSWR<Meta>('/api/meta');
  const { data: settings, mutate } = useSettings();
  const enabled = new Set((settings?.markets?.enabled as string[] | undefined) ?? []);
  async function toggle(key: string, on: boolean) {
    const next = new Set(enabled);
    if (on) next.add(key);
    else next.delete(key);
    await put('/api/admin/settings/markets', { enabled: [...next] });
    mutate();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Markets</CardTitle>
        <CardDescription>
          Disabled markets are not priced, scanned or stored as signals.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {meta?.markets.map((m) => (
          <label
            key={m.key}
            className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
          >
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="ml-2 text-[11px] text-muted-foreground">{m.category}</span>
            </span>
            <Switch checked={enabled.has(m.key)} onCheckedChange={(v) => toggle(m.key, v)} />
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ users

interface UserRow {
  id: number;
  email: string;
  role: 'user' | 'admin';
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export function UsersPanel() {
  const { data, mutate } = useSWR<UserRow[]>('/api/admin/users');
  const [error, setError] = useState<string | null>(null);
  async function update(id: number, body: Partial<UserRow>) {
    setError(null);
    try {
      await patch(`/api/admin/users/${id}`, body);
      mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }
  return (
    <div className="space-y-3">
      {error && <Notice tone="warn">{error}</Notice>}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last login</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.email}</TableCell>
                <TableCell>
                  <Select
                    value={u.role}
                    onChange={(e) => update(u.id, { role: e.target.value as UserRow['role'] })}
                    className="w-28"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </Select>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={u.is_active}
                    onCheckedChange={(v) => update(u.id, { is_active: v })}
                  />
                </TableCell>
                <TableCell className="text-xs">{dateTime(u.created_at)}</TableCell>
                <TableCell className="text-xs">{dateTime(u.last_login_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ usage & logs

interface UsageRow {
  provider: string;
  day: string;
  endpoint: string;
  calls: number;
  errors: number;
  remaining: number | null;
}

export function UsagePanel() {
  const { data } = useSWR<UsageRow[]>('/api/admin/usage?days=14', { refreshInterval: 60_000 });
  const totals = new Map<string, { calls: number; errors: number; remaining: number | null }>();
  for (const r of data ?? []) {
    const k = `${r.day} · ${r.provider}`;
    const t = totals.get(k) ?? { calls: 0, errors: 0, remaining: null };
    t.calls += r.calls;
    t.errors += r.errors;
    t.remaining = r.remaining ?? t.remaining;
    totals.set(k, t);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Calls per day</CardTitle>
        </CardHeader>
        <CardContent>
          {totals.size === 0 ? (
            <Empty>No API calls recorded.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Day · provider</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Quota left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...totals.entries()].map(([k, t]) => (
                  <TableRow key={k}>
                    <TableCell>{k}</TableCell>
                    <TableCell className="num text-right">{t.calls}</TableCell>
                    <TableCell className={cn('num text-right', t.errors && 'text-signal-avoid')}>
                      {t.errors}
                    </TableCell>
                    <TableCell className="num text-right">{t.remaining ?? NA}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By endpoint</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {(data ?? []).slice(0, 40).map((r) => (
                <TableRow key={`${r.day}-${r.provider}-${r.endpoint}`}>
                  <TableCell className="text-xs text-muted-foreground">{r.day}</TableCell>
                  <TableCell className="text-xs">{r.provider}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs">{r.endpoint}</TableCell>
                  <TableCell className="num text-right text-xs">{r.calls}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

interface LogRow {
  id: number;
  time: string;
  level: string;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
}

export function LogsPanel() {
  const [level, setLevel] = useState('');
  const { data } = useSWR<LogRow[]>(`/api/admin/logs?limit=300${level ? `&level=${level}` : ''}`, {
    refreshInterval: 30_000,
  });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-40">
        <option value="">All levels</option>
        <option>INFO</option>
        <option>WARNING</option>
        <option>ERROR</option>
      </Select>
      {!data || data.length === 0 ? (
        <Empty>No log entries.</Empty>
      ) : (
        <div className="rounded-lg border font-mono text-xs">
          {data.map((l) => (
            <div key={l.id} className="border-b p-2 last:border-0">
              <button
                type="button"
                className="flex w-full gap-3 text-left"
                onClick={() => setOpen(open === l.id ? null : l.id)}
              >
                <span className="shrink-0 text-muted-foreground">{dateTime(l.time)}</span>
                <span
                  className={cn(
                    'w-14 shrink-0 font-bold',
                    l.level === 'ERROR'
                      ? 'text-signal-avoid'
                      : l.level === 'WARNING'
                        ? 'text-signal-moderate'
                        : 'text-signal-strong',
                  )}
                >
                  {l.level}
                </span>
                <span className="w-28 shrink-0 truncate text-muted-foreground">{l.source}</span>
                <span className="min-w-0 break-words">{l.message}</span>
              </button>
              {open === l.id && l.context && (
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                  {JSON.stringify(l.context, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ performance

interface PerfResponse {
  overall: Performance;
  calibration: { bucket: string; count: number; predicted: number; observed: number }[];
  by_market: Record<string, Performance>;
  note: string;
}

export function PerformancePanel() {
  const { data } = useSWR<PerfResponse>('/api/admin/performance');
  if (!data) return null;
  const o = data.overall;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Settled signals" v={String(o.settled_bets)} />
        <Tile k="ROI" v={pct(o.roi)} />
        <Tile k="Brier score" v={num(o.brier_score, 4)} />
        <Tile k="Log loss" v={num(o.log_loss, 4)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Calibration</CardTitle>
            <CardDescription>
              Predicted vs observed win rate. A calibrated model sits on the diagonal.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.calibration.length === 0 ? (
              <Empty>Not enough settled signals yet.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Bucket</TableHead>
                    <TableHead className="text-right">Signals</TableHead>
                    <TableHead className="text-right">Predicted</TableHead>
                    <TableHead className="text-right">Observed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.calibration.map((c) => (
                    <TableRow key={c.bucket}>
                      <TableCell>{c.bucket}</TableCell>
                      <TableCell className="num text-right">{c.count}</TableCell>
                      <TableCell className="num text-right">{pct(c.predicted)}</TableCell>
                      <TableCell className="num text-right">{pct(c.observed)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By market</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Bets</TableHead>
                  <TableHead className="text-right">Avg odds</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data.by_market).map(([m, s]) => (
                  <TableRow key={m}>
                    <TableCell>{m}</TableCell>
                    <TableCell className="num text-right">{s.settled_bets}</TableCell>
                    <TableCell className="num text-right">{odds(s.average_odds)}</TableCell>
                    <TableCell className="num text-right">{units(s.profit)}</TableCell>
                    <TableCell className="num text-right">{pct(s.roi)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">{data.note}</p>
    </div>
  );
}

function Tile({ k, v }: { k: string; v: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
        <div className="num text-xl font-bold">{v}</div>
      </CardContent>
    </Card>
  );
}
