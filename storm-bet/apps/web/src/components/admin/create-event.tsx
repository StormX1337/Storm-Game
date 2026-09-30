'use client';

import type { AdminCatalogDto, AdminEventDto, MarketType, SportKey } from '@storm-bet/types';
import {
  isSupportedLine,
  MARKET_DEFINITIONS,
  MARKET_TYPES,
  OUTCOME_LABELS,
} from '@storm-bet/types';
import { Button, Card, Field, Input, NativeSelect, toast } from '@storm-bet/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { uuid } from '@/lib/uuid';

interface MarketDraft {
  id: string;
  type: MarketType;
  line: string;
  odds: Record<string, string>;
}

const DEFAULTS: Record<SportKey, { type: MarketType; line?: string }[]> = {
  football: [
    { type: 'MATCH_RESULT' },
    { type: 'TOTAL_GOALS', line: '2.5' },
    { type: 'BOTH_TEAMS_TO_SCORE' },
  ],
  tennis: [{ type: 'MATCH_WINNER' }, { type: 'TOTAL_GAMES', line: '22.5' }],
  basketball: [{ type: 'MATCH_WINNER' }, { type: 'TOTAL_POINTS', line: '165.5' }],
};

const draft = (type: MarketType, line = ''): MarketDraft => ({
  id: uuid(),
  type,
  line,
  odds: {},
});

function defaultStart() {
  const d = new Date(Date.now() + 2 * 3_600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CreateEventForm({ catalog }: { catalog: AdminCatalogDto }) {
  const router = useRouter();
  const [sport, setSport] = useState<SportKey>('football');
  const leagues = useMemo(
    () => catalog.leagues.filter((l) => l.sportKey === sport),
    [catalog, sport],
  );
  const teams = useMemo(() => catalog.teams.filter((t) => t.sportKey === sport), [catalog, sport]);
  const [leagueId, setLeagueId] = useState(leagues[0]?.id ?? '');
  const [homeTeamId, setHome] = useState(teams[0]?.id ?? '');
  const [awayTeamId, setAway] = useState(teams[1]?.id ?? '');
  const [start, setStart] = useState(defaultStart);
  const [markets, setMarkets] = useState<MarketDraft[]>(
    DEFAULTS.football.map((m) => draft(m.type, m.line)),
  );
  const [busy, setBusy] = useState(false);

  const available = MARKET_TYPES.filter(
    // Player markets need a player per selection; they come from the feed only.
    (t) =>
      MARKET_DEFINITIONS[t].sports.includes(sport) &&
      t !== 'PLAYER_TO_SCORE' &&
      MARKET_DEFINITIONS[t].kind !== 'PLAYER_TOTAL',
  );

  const changeSport = (next: SportKey) => {
    setSport(next);
    const l = catalog.leagues.filter((x) => x.sportKey === next);
    const t = catalog.teams.filter((x) => x.sportKey === next);
    setLeagueId(l[0]?.id ?? '');
    setHome(t[0]?.id ?? '');
    setAway(t[1]?.id ?? '');
    setMarkets(DEFAULTS[next].map((m) => draft(m.type, m.line)));
  };

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        sport,
        leagueId,
        homeTeamId,
        awayTeamId,
        startTime: new Date(start).toISOString(),
        markets: markets.map((m) => {
          const def = MARKET_DEFINITIONS[m.type];
          return {
            type: m.type,
            line: def.hasLine ? Number(m.line.replace(',', '.')) : null,
            selections: def.outcomes.map((o) => ({
              outcome: o,
              odds: Number((m.odds[o] ?? '').replace(',', '.')),
            })),
          };
        }),
      };
      const created = await api<AdminEventDto>('/admin/events', { body: payload });
      toast.success('Event angelegt');
      router.push(`/admin/events/${created.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const valid =
    leagueId &&
    homeTeamId &&
    awayTeamId &&
    homeTeamId !== awayTeamId &&
    markets.length > 0 &&
    markets.every((m) => {
      const def = MARKET_DEFINITIONS[m.type];
      const lineOk = !def.hasLine || isSupportedLine(Number(m.line.replace(',', '.')));
      return lineOk && def.outcomes.every((o) => Number((m.odds[o] ?? '').replace(',', '.')) > 1);
    });

  return (
    <div className="space-y-4">
      <Card className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="Sportart" htmlFor="sport">
          <NativeSelect
            id="sport"
            value={sport}
            onChange={(e) => changeSport(e.target.value as SportKey)}
          >
            {catalog.sports.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Wettbewerb" htmlFor="league">
          <NativeSelect id="league" value={leagueId} onChange={(e) => setLeagueId(e.target.value)}>
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Anstoß" htmlFor="start">
          <Input
            id="start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="Heim" htmlFor="home">
          <NativeSelect id="home" value={homeTeamId} onChange={(e) => setHome(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Auswärts"
          htmlFor="away"
          error={homeTeamId === awayTeamId ? 'Muss sich vom Heimteam unterscheiden' : undefined}
        >
          <NativeSelect id="away" value={awayTeamId} onChange={(e) => setAway(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Card>

      {markets.map((m) => {
        const def = MARKET_DEFINITIONS[m.type];
        return (
          <Card key={m.id} className="flex flex-wrap items-end gap-3 p-4">
            <Field label="Markt" htmlFor={`type-${m.id}`} className="w-56">
              <NativeSelect
                id={`type-${m.id}`}
                value={m.type}
                onChange={(e) =>
                  setMarkets((p) =>
                    p.map((x) =>
                      x.id === m.id ? { ...x, type: e.target.value as MarketType, odds: {} } : x,
                    ),
                  )
                }
              >
                {available.map((t) => (
                  <option key={t} value={t}>
                    {MARKET_DEFINITIONS[t].label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {def.hasLine ? (
              <Field label="Linie" htmlFor={`line-${m.id}`} className="w-24">
                <Input
                  id={`line-${m.id}`}
                  inputMode="decimal"
                  value={m.line}
                  onChange={(e) =>
                    setMarkets((p) =>
                      p.map((x) => (x.id === m.id ? { ...x, line: e.target.value } : x)),
                    )
                  }
                />
              </Field>
            ) : null}
            {def.outcomes.map((o) => (
              <Field
                key={o}
                label={`Quote ${OUTCOME_LABELS[o]}`}
                htmlFor={`odds-${m.id}-${o}`}
                className="w-24"
              >
                <Input
                  id={`odds-${m.id}-${o}`}
                  inputMode="decimal"
                  placeholder="1.90"
                  value={m.odds[o] ?? ''}
                  onChange={(e) =>
                    setMarkets((p) =>
                      p.map((x) =>
                        x.id === m.id ? { ...x, odds: { ...x.odds, [o]: e.target.value } } : x,
                      ),
                    )
                  }
                />
              </Field>
            ))}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Markt entfernen"
              onClick={() => setMarkets((p) => p.filter((x) => x.id !== m.id))}
            >
              <Trash2 />
            </Button>
          </Card>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => setMarkets((p) => [...p, draft(available[0] ?? 'MATCH_WINNER')])}
        >
          <Plus /> Markt hinzufügen
        </Button>
        <Button onClick={() => void submit()} loading={busy} disabled={!valid}>
          Event anlegen
        </Button>
      </div>
    </div>
  );
}
