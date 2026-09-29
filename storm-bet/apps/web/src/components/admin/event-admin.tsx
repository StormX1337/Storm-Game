'use client';

import type {
  AdminEventDto,
  AdminMarketDto,
  AdminSelectionDto,
  EventStatistics,
} from '@storm-bet/types';
import { hasPermission, Permission } from '@storm-bet/types';
import {
  Badge,
  Button,
  Card,
  cn,
  Field,
  Input,
  NativeSelect,
  Table,
  Td,
  Th,
  toast,
} from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatOdds } from '@/lib/format';
import { useSession } from '../providers/session';
import { ReasonAction } from './reason-action';

export function EventActions({ event }: { event: AdminEventDto }) {
  const { user } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const canManage = hasPermission(user.role, Permission.EVENTS_MANAGE);
  const canSettle = hasPermission(user.role, Permission.BETS_SETTLE);
  const settled = !!event.settledAt;
  const action = (
    name: string,
    label: string,
    opts: { destructive?: boolean; description?: string } = {},
  ) => (
    <ReasonAction
      key={name}
      label={label}
      title={`Event: ${label}`}
      description={opts.description}
      path={`/admin/events/${event.id}/actions`}
      body={{ action: name }}
      destructive={opts.destructive}
      variant={opts.destructive ? 'destructive' : 'outline'}
      successMessage="Event aktualisiert"
    />
  );
  return (
    <div className="flex flex-wrap gap-2">
      {canManage && !settled ? (
        <>
          {event.isActive
            ? action('deactivate', 'Deaktivieren', {
                description:
                  'Das Event verschwindet aus dem Angebot und nimmt keine Wetten mehr an.',
              })
            : action('activate', 'Aktivieren')}
          {event.tradingSuspended || event.rawStatus === 'POSTPONED'
            ? action('resume', 'Freigeben')
            : action('suspend', 'Suspendieren')}
          {event.provider === 'manual' && event.rawStatus === 'SCHEDULED'
            ? action('start', 'Live schalten')
            : null}
          {event.rawStatus === 'SCHEDULED' ? action('postpone', 'Verschieben') : null}
          {event.rawStatus !== 'FINISHED' && event.rawStatus !== 'CANCELLED'
            ? action('cancel', 'Absagen', {
                destructive: true,
                description: 'Alle offenen Auswahlen dieses Events werden storniert (Quote 1,00).',
              })
            : null}
        </>
      ) : null}
      {canSettle &&
      !settled &&
      (event.rawStatus === 'FINISHED' || event.rawStatus === 'CANCELLED') ? (
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/admin/events/${event.id}/settle`, { method: 'POST' });
              toast.success('Abrechnung ausgeführt');
              router.refresh();
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Jetzt abrechnen
        </Button>
      ) : null}
    </div>
  );
}

function SelectionOdds({
  selection,
  editable,
}: {
  selection: AdminSelectionDto;
  editable: boolean;
}) {
  const [odds, setOdds] = useState(formatOdds(selection.odds));
  if (!editable) return <span className="tabular font-semibold">{formatOdds(selection.odds)}</span>;
  const parsed = Number(odds.replace(',', '.'));
  return (
    <ReasonAction
      label={<span className="tabular">{formatOdds(selection.odds)}</span>}
      title={`Quote ändern: ${selection.name}`}
      description="Die Änderung erhöht die Quotenversion; Wettscheine mit der alten Quote werden abgelehnt."
      path={`/admin/selections/${selection.id}`}
      method="PATCH"
      body={{ odds: parsed }}
      extraValid={Number.isFinite(parsed) && parsed > 1}
      successMessage="Quote geändert"
      variant="secondary"
    >
      <Field label="Neue Quote" htmlFor={`odds-${selection.id}`}>
        <Input
          id={`odds-${selection.id}`}
          inputMode="decimal"
          value={odds}
          onChange={(e) => setOdds(e.target.value)}
        />
      </Field>
    </ReasonAction>
  );
}

const RESULT_VARIANT = {
  PENDING: 'default',
  WON: 'success',
  LOST: 'danger',
  VOID: 'warning',
} as const;

function MarketRow({
  market,
  event,
  canManage,
}: {
  market: AdminMarketDto;
  event: AdminEventDto;
  canManage: boolean;
}) {
  const manual = event.provider === 'manual';
  const locked = market.rawStatus === 'SETTLED' || !!event.settledAt;
  return (
    <tr>
      <Td>
        <p className="font-medium">{market.name}</p>
        <div className="mt-1 flex gap-1">
          <Badge
            variant={
              market.rawStatus === 'OPEN'
                ? 'success'
                : market.rawStatus === 'SETTLED'
                  ? 'default'
                  : 'warning'
            }
          >
            {market.rawStatus}
          </Badge>
          {market.tradingSuspended ? <Badge variant="warning">Staff-Sperre</Badge> : null}
        </div>
      </Td>
      <Td>
        <div className="flex flex-wrap gap-2">
          {market.selections.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            >
              <span className="max-w-40 truncate text-fg-muted">{s.name}</span>
              <SelectionOdds selection={s} editable={canManage && manual && !locked} />
              {s.result !== 'PENDING' ? (
                <Badge variant={RESULT_VARIANT[s.result]}>{s.result}</Badge>
              ) : null}
            </div>
          ))}
        </div>
      </Td>
      <Td className="whitespace-nowrap">
        {canManage && !locked ? (
          <div className="flex gap-1">
            {market.tradingSuspended || market.rawStatus !== 'OPEN' ? (
              <ReasonAction
                label="Öffnen"
                title={`${market.name} öffnen`}
                path={`/admin/markets/${market.id}/actions`}
                body={{ action: 'open' }}
                successMessage="Markt geöffnet"
              />
            ) : (
              <ReasonAction
                label="Sperren"
                title={`${market.name} suspendieren`}
                path={`/admin/markets/${market.id}/actions`}
                body={{ action: 'suspend' }}
                successMessage="Markt suspendiert"
              />
            )}
            {market.rawStatus !== 'CLOSED' ? (
              <ReasonAction
                label="Schließen"
                title={`${market.name} schließen`}
                path={`/admin/markets/${market.id}/actions`}
                body={{ action: 'close' }}
                successMessage="Markt geschlossen"
                variant="ghost"
              />
            ) : null}
          </div>
        ) : null}
      </Td>
    </tr>
  );
}

export function MarketsTable({ event }: { event: AdminEventDto }) {
  const { user } = useSession();
  const canManage = !!user && hasPermission(user.role, Permission.MARKETS_MANAGE);
  return (
    <Card className="overflow-hidden">
      <Table>
        <thead>
          <tr>
            <Th>Markt</Th>
            <Th>Auswahlen & Quoten</Th>
            <Th>Aktionen</Th>
          </tr>
        </thead>
        <tbody>
          {event.markets.map((m) => (
            <MarketRow key={m.id} market={m} event={event} canManage={canManage} />
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

export function ResultForm({ event }: { event: AdminEventDto }) {
  const { user } = useSession();
  const [f, setF] = useState({
    home: '0',
    away: '0',
    cornersH: '0',
    cornersA: '0',
    yellowH: '0',
    yellowA: '0',
    redH: '0',
    redA: '0',
  });
  const [sets, setSets] = useState([
    ['6', '4'],
    ['6', '4'],
    ['', ''],
  ]);
  const [scorers, setScorers] = useState<Record<string, string>>({});
  if (
    !user ||
    !hasPermission(user.role, Permission.BETS_SETTLE) ||
    event.settledAt ||
    event.rawStatus === 'CANCELLED'
  )
    return null;

  const playerMarket = event.markets.find((m) => m.type === 'PLAYER_TO_SCORE');
  const players = playerMarket?.selections.filter((s) => s.playerId) ?? [];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  let statistics: EventStatistics;
  if (event.sport.key === 'football') {
    const goals = { home: num(f.home), away: num(f.away) };
    const goalEvents = [
      ...Array.from({ length: goals.home }, (_, i) => ({ side: 'HOME' as const, key: `H${i}` })),
      ...Array.from({ length: goals.away }, (_, i) => ({ side: 'AWAY' as const, key: `A${i}` })),
    ].map((g, i) => {
      const playerId = scorers[g.key] || null;
      return {
        minute: Math.min(90, 10 + i * 7),
        side: g.side,
        playerId,
        playerName: players.find((p) => p.playerId === playerId)?.name ?? null,
      };
    });
    statistics = {
      sport: 'football',
      goals,
      corners: { home: num(f.cornersH), away: num(f.cornersA) },
      yellowCards: { home: num(f.yellowH), away: num(f.yellowA) },
      redCards: { home: num(f.redH), away: num(f.redA) },
      shotsOnTarget: { home: goals.home, away: goals.away },
      possession: { home: 50, away: 50 },
      goalEvents,
    };
  } else if (event.sport.key === 'tennis') {
    const played = sets
      .filter(([h, a]) => h !== '' && a !== '')
      .map(([h, a]) => ({ home: num(h ?? ''), away: num(a ?? '') }));
    statistics = {
      sport: 'tennis',
      sets: played,
      setsWon: {
        home: played.filter((s) => s.home > s.away).length,
        away: played.filter((s) => s.away > s.home).length,
      },
      currentGame: null,
      server: null,
      aces: { home: 0, away: 0 },
    };
  } else {
    const points = { home: num(f.home), away: num(f.away) };
    statistics = { sport: 'basketball', points, periods: [points], fouls: { home: 0, away: 0 } };
  }

  const pair = (label: string, a: keyof typeof f, b: keyof typeof f) => (
    <Field label={label} htmlFor={`r-${a}`}>
      <div className="flex items-center gap-2">
        <Input
          id={`r-${a}`}
          inputMode="numeric"
          value={f[a]}
          onChange={set(a)}
          className="w-16 text-center"
        />
        <span className="text-fg-subtle">:</span>
        <Input
          inputMode="numeric"
          value={f[b]}
          onChange={set(b)}
          className="w-16 text-center"
          aria-label={`${label} Auswärts`}
        />
      </div>
    </Field>
  );

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">Ergebnis erfassen & abrechnen</p>
      <p className="mt-1 text-xs text-fg-muted">
        Setzt das Event auf „Beendet“, bestätigt das Ergebnis und rechnet alle betroffenen Wetten
        sofort ab. Danach ist das Ergebnis unveränderlich.
      </p>
      <div className="mt-4 flex flex-wrap gap-4">
        {event.sport.key === 'football' ? (
          <>
            {pair('Tore', 'home', 'away')}
            {pair('Ecken', 'cornersH', 'cornersA')}
            {pair('Gelbe Karten', 'yellowH', 'yellowA')}
            {pair('Rote Karten', 'redH', 'redA')}
          </>
        ) : event.sport.key === 'tennis' ? (
          sets.map(([h, a], i) => (
            <Field key={i} label={`Satz ${i + 1}`} htmlFor={`set-${i}`}>
              <div className="flex items-center gap-2">
                <Input
                  id={`set-${i}`}
                  inputMode="numeric"
                  value={h}
                  className="w-14 text-center"
                  onChange={(e) =>
                    setSets((p) => p.map((s, k) => (k === i ? [e.target.value, s[1] ?? ''] : s)))
                  }
                />
                <span className="text-fg-subtle">:</span>
                <Input
                  inputMode="numeric"
                  value={a}
                  className="w-14 text-center"
                  aria-label={`Satz ${i + 1} Auswärts`}
                  onChange={(e) =>
                    setSets((p) => p.map((s, k) => (k === i ? [s[0] ?? '', e.target.value] : s)))
                  }
                />
              </div>
            </Field>
          ))
        ) : (
          pair('Punkte', 'home', 'away')
        )}
      </div>
      {event.sport.key === 'football' &&
      players.length > 0 &&
      statistics.sport === 'football' &&
      statistics.goalEvents.length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {statistics.goalEvents.map((g, i) => {
            const key = `${g.side === 'HOME' ? 'H' : 'A'}${statistics.sport === 'football' ? statistics.goalEvents.slice(0, i).filter((x) => x.side === g.side).length : 0}`;
            return (
              <Field
                key={key}
                label={`Torschütze ${g.side === 'HOME' ? event.home.name : event.away.name} #${key.slice(1)}`}
                htmlFor={`scorer-${key}`}
              >
                <NativeSelect
                  id={`scorer-${key}`}
                  value={scorers[key] ?? ''}
                  onChange={(e) => setScorers((p) => ({ ...p, [key]: e.target.value }))}
                >
                  <option value="">Anderer Spieler / Eigentor</option>
                  {players.map((p) => (
                    <option key={p.id} value={p.playerId ?? ''}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            );
          })}
        </div>
      ) : null}
      <div className={cn('mt-4')}>
        <ReasonAction
          label="Ergebnis speichern & abrechnen"
          title="Ergebnis bestätigen"
          description="Das Ergebnis ist nach der Abrechnung unveränderlich. Bitte prüfe die Eingaben."
          path={`/admin/events/${event.id}/result`}
          body={{ statistics }}
          variant="primary"
          size="md"
          successMessage="Ergebnis gespeichert und abgerechnet"
        />
      </div>
    </Card>
  );
}
