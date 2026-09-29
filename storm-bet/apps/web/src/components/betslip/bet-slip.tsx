'use client';

import type { PlaceBetResponse, SlipIssueDto, ValidateSlipResponse } from '@storm-bet/types';
import { Button, Checkbox, cn, EmptyState, toast } from '@storm-bet/ui';
import { AlertTriangle, Lock, Ticket, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { formatMoney, formatOdds, parseStake } from '@/lib/format';
import { effectiveMode, useBetSlip, type SlipItem } from '@/stores/bet-slip';
import { useLive } from '@/stores/live';
import { announceWalletChange, useSession } from '../providers/session';
import { useRealtimeTopics } from '../providers/realtime';

const QUICK_STAKES = [500, 1000, 2500, 5000];

function slipPayload(
  items: SlipItem[],
  mode: 'SINGLES' | 'COMBO',
  comboStake: string,
  singleStakes: Record<string, string>,
  acceptHigher: boolean,
) {
  const policy = acceptHigher ? 'ACCEPT_HIGHER' : 'REJECT';
  if (mode === 'COMBO') {
    return {
      mode,
      stake: parseStake(comboStake) ?? 0,
      oddsChangePolicy: policy,
      selections: items.map((i) => ({ selectionId: i.selectionId, odds: i.odds })),
    } as const;
  }
  return {
    mode,
    oddsChangePolicy: policy,
    selections: items.map((i) => ({
      selectionId: i.selectionId,
      odds: i.odds,
      stake: parseStake(singleStakes[i.selectionId] ?? '') ?? 0,
    })),
  } as const;
}

/** Local estimate while the server quote is in flight; the server figure replaces it. */
function localQuote(
  items: SlipItem[],
  mode: 'SINGLES' | 'COMBO',
  comboStake: string,
  singleStakes: Record<string, string>,
) {
  if (mode === 'COMBO') {
    const milli = items.reduce(
      (acc, i) => (acc * BigInt(Math.round(i.odds * 1000))) / 1000n,
      1000n,
    );
    const stake = parseStake(comboStake) ?? 0;
    return {
      totalOdds: Number(milli) / 1000,
      stake,
      potentialReturn: Math.floor((stake * Number(milli)) / 1000),
    };
  }
  let stake = 0;
  let potentialReturn = 0;
  for (const i of items) {
    const s = parseStake(singleStakes[i.selectionId] ?? '') ?? 0;
    stake += s;
    potentialReturn += Math.floor((s * Math.round(i.odds * 1000)) / 1000);
  }
  return { totalOdds: 0, stake, potentialReturn };
}

export function BetSlip({ className, onPlaced }: { className?: string; onPlaced?: () => void }) {
  const slip = useBetSlip();
  const { user, wallet } = useSession();
  const pathname = usePathname();
  const mode = effectiveMode(slip.items, slip.mode);
  const [quote, setQuote] = useState<ValidateSlipResponse | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PlaceBetResponse | null>(null);
  const requestId = useRef(0);

  useRealtimeTopics(slip.items.map((i) => `event:${i.eventId}`));

  const payload = useMemo(
    () => slipPayload(slip.items, mode, slip.comboStake, slip.singleStakes, slip.acceptHigher),
    [slip.items, mode, slip.comboStake, slip.singleStakes, slip.acceptHigher],
  );
  // Status updates change `items` without changing what is sent; key on content.
  const payloadKey = JSON.stringify(payload);

  // Server-side quote: current prices, statuses, limits — debounced.
  useEffect(() => {
    if (payload.selections.length === 0) {
      setQuote(null);
      return;
    }
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api<ValidateSlipResponse>('/bets/validate', { body: payload });
        if (id !== requestId.current) return;
        setQuote(result);
        const { observe, items } = useBetSlip.getState();
        const applyLive = useLive.getState().apply;
        for (const s of result.selections) {
          const status = s.bettable ? 'OPEN' : s.status === 'OPEN' ? 'SUSPENDED' : s.status;
          observe(s.selectionId, s.currentOdds, status);
          // The server's answer is also the freshest price for the odds buttons on the page.
          const marketId = items.find((i) => i.selectionId === s.selectionId)?.marketId;
          if (marketId) {
            applyLive({
              type: 'odds',
              eventId: s.eventId,
              selections: [
                {
                  id: s.selectionId,
                  marketId,
                  odds: s.currentOdds,
                  status,
                  oddsVersion: s.oddsVersion,
                },
              ],
            });
          }
        }
      } catch {
        if (id === requestId.current) setQuote(null);
      }
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- payloadKey captures payload
  }, [payloadKey]);

  const estimate = localQuote(slip.items, mode, slip.comboStake, slip.singleStakes);
  const totalOdds =
    quote?.quote.mode === mode && mode === 'COMBO' ? quote.quote.totalOdds : estimate.totalOdds;
  const potentialReturn =
    quote?.quote.mode === mode ? quote.quote.potentialReturn : estimate.potentialReturn;
  const totalStake = estimate.stake;
  const changed = slip.items.filter((i) => i.pendingOdds != null);
  const blocked = slip.items.filter((i) => i.status !== 'OPEN');
  const issues: SlipIssueDto[] = (quote?.issues ?? []).filter((i) => i.code !== 'ODDS_CHANGED');
  const insufficient = wallet ? totalStake > wallet.available : false;
  const canPlace =
    !!user &&
    slip.items.length > 0 &&
    totalStake > 0 &&
    changed.length === 0 &&
    blocked.length === 0 &&
    !placing &&
    !insufficient;

  const place = async () => {
    if (!canPlace) return;
    setPlacing(true);
    setError(null);
    const idempotencyKey = slip.ensureKey();
    try {
      const result = await api<PlaceBetResponse>('/bets/place', {
        body: { ...payload, idempotencyKey },
      });
      setReceipt(result);
      slip.clear();
      announceWalletChange(result.wallet);
      toast.success(
        result.bets.length > 1
          ? `${result.bets.length} Wetten platziert`
          : `Wette platziert · ${result.bets[0]?.reference ?? ''}`,
      );
      onPlaced?.();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'ODDS_CHANGED') {
        const list = (err.details?.issues as SlipIssueDto[] | undefined) ?? [];
        for (const i of list) {
          if (i.selectionId && i.currentOdds) slip.observe(i.selectionId, i.currentOdds, 'OPEN');
        }
      }
      // A definitive answer ends this submission; the next attempt is a new slip.
      if (err && err.code !== 'SERVICE_UNAVAILABLE' && err.code !== 'INTERNAL_ERROR')
        slip.resetKey();
      setError(err?.message ?? 'Die Wette konnte nicht platziert werden.');
    } finally {
      setPlacing(false);
    }
  };

  if (receipt) {
    return (
      <div className={cn('flex flex-col', className)} data-testid="bet-receipt">
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-up/30 bg-up-soft p-4">
            <p className="text-sm font-semibold text-up">Wette angenommen</p>
            <p className="mt-1 text-xs text-fg-muted">
              Dein Einsatz ist reserviert. Die Abrechnung erfolgt automatisch nach Spielende.
            </p>
          </div>
          {receipt.bets.map((bet) => (
            <div key={bet.id} className="rounded-md border border-border bg-surface-2 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-fg-muted">{bet.reference}</span>
                <span className="tabular font-semibold">{formatOdds(bet.totalOdds)}</span>
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between text-fg-muted">
                  <dt>Einsatz</dt>
                  <dd className="tabular">{formatMoney(bet.stake)}</dd>
                </div>
                <div className="flex justify-between text-fg-muted">
                  <dt>Möglicher Gewinn</dt>
                  <dd className="tabular font-semibold text-up">
                    {formatMoney(bet.potentialReturn)}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setReceipt(null)}>
              Weiter wetten
            </Button>
            <Button variant="outline" asChild>
              <Link href="/dashboard/bets">Meine Wetten</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (slip.items.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          icon={<Ticket />}
          title="Dein Wettschein ist leer"
          description="Tippe auf eine Quote, um eine Auswahl hinzuzufügen."
        />
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="bet-slip">
      {slip.items.length > 1 ? (
        <div
          className="grid grid-cols-2 gap-1 border-b border-border p-2"
          role="tablist"
          aria-label="Wettart"
        >
          {(['COMBO', 'SINGLES'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => slip.setMode(m)}
              className={cn(
                'rounded-md py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {m === 'COMBO' ? 'Kombi' : 'Einzelwetten'}
            </button>
          ))}
        </div>
      ) : null}

      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {slip.items.map((item) => (
          <li key={item.selectionId} className="p-3" data-testid="slip-item">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{item.selectionName}</p>
                <p className="truncate text-xs text-fg-muted">{item.marketName}</p>
                <p className="truncate text-xs text-fg-subtle">
                  {item.isLive ? <span className="mr-1 font-semibold text-live">LIVE</span> : null}
                  {item.eventName}
                </p>
              </div>
              <div className="text-right">
                {item.status !== 'OPEN' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-warning">
                    <Lock className="size-3" /> Gesperrt
                  </span>
                ) : item.pendingOdds != null ? (
                  <span className="flex flex-col items-end">
                    <span className="tabular text-xs text-fg-subtle line-through">
                      {formatOdds(item.odds)}
                    </span>
                    <span
                      className={cn(
                        'tabular text-sm font-semibold',
                        item.pendingOdds > item.odds ? 'text-up' : 'text-down',
                      )}
                    >
                      {formatOdds(item.pendingOdds)}
                    </span>
                  </span>
                ) : (
                  <span className="tabular text-sm font-semibold">{formatOdds(item.odds)}</span>
                )}
              </div>
              <button
                onClick={() => slip.remove(item.selectionId)}
                className="-mr-1 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
                aria-label={`${item.selectionName} entfernen`}
              >
                <X className="size-3.5" />
              </button>
            </div>
            {mode === 'SINGLES' ? (
              <StakeInput
                value={slip.singleStakes[item.selectionId] ?? ''}
                onChange={(v) => slip.setSingleStake(item.selectionId, v)}
                label={`Einsatz für ${item.selectionName}`}
              />
            ) : null}
          </li>
        ))}
      </ul>

      <div className="space-y-3 border-t border-border p-3">
        {changed.length > 0 ? (
          <div
            className="rounded-md border border-warning/30 bg-warning-soft p-3"
            role="alert"
            data-testid="odds-changed"
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
              <AlertTriangle className="size-4" /> Quote wurde aktualisiert.
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {changed.length === 1 ? 'Eine Quote hat sich' : `${changed.length} Quoten haben sich`}{' '}
              geändert. Bitte prüfe und bestätige die neuen Quoten.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => slip.acceptChanges()}
            >
              Neue Quoten übernehmen
            </Button>
          </div>
        ) : null}
        {blocked.length > 0 ? (
          <p className="rounded-md bg-surface-2 p-2.5 text-xs text-fg-muted">
            Gesperrte Auswahlen können nicht gewettet werden. Entferne sie oder warte, bis der Markt
            wieder öffnet.
          </p>
        ) : null}

        {mode === 'COMBO' ? (
          <StakeInput value={slip.comboStake} onChange={slip.setComboStake} label="Einsatz" quick />
        ) : null}

        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between text-fg-muted">
            <dt>Auswahlen</dt>
            <dd className="tabular">{slip.items.length}</dd>
          </div>
          {mode === 'COMBO' ? (
            <div className="flex justify-between text-fg-muted">
              <dt>Gesamtquote</dt>
              <dd className="tabular font-semibold text-fg" data-testid="total-odds">
                {formatOdds(totalOdds)}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-fg-muted">
            <dt>Einsatz</dt>
            <dd className="tabular">{formatMoney(totalStake)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Möglicher Gewinn</dt>
            <dd className="tabular font-semibold text-up" data-testid="potential-return">
              {formatMoney(potentialReturn)}
            </dd>
          </div>
        </dl>

        <Checkbox
          checked={slip.acceptHigher}
          onChange={(e) => slip.setAcceptHigher(e.target.checked)}
          label={
            <span className="text-xs">Höhere Quoten automatisch akzeptieren (max. +10 %)</span>
          }
        />

        {issues.length > 0 || insufficient || error ? (
          <div className="space-y-1" role="alert">
            {insufficient ? (
              <p className="text-xs text-down">Dein verfügbares Demo-Guthaben reicht nicht aus.</p>
            ) : null}
            {issues.map((i, n) => (
              <p key={`${i.code}-${n}`} className="text-xs text-down">
                {i.message}
              </p>
            ))}
            {error ? (
              <p className="text-xs text-down" data-testid="slip-error">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {user ? (
          <Button
            className="w-full"
            size="lg"
            disabled={!canPlace}
            loading={placing}
            onClick={() => void place()}
            data-testid="place-bet"
          >
            {totalStake > 0 ? `Wette platzieren · ${formatMoney(totalStake)}` : 'Einsatz eingeben'}
          </Button>
        ) : (
          <Button className="w-full" size="lg" asChild>
            <Link href={`/login?next=${encodeURIComponent(pathname)}`}>Anmelden, um zu wetten</Link>
          </Button>
        )}
        <div className="flex items-center justify-between text-xs text-fg-subtle">
          <span>Nur Demo-Guthaben · kein Echtgeld</span>
          <button
            onClick={() => slip.clear()}
            className="inline-flex items-center gap-1 hover:text-fg"
          >
            <Trash2 className="size-3" /> Leeren
          </button>
        </div>
      </div>
    </div>
  );
}

function StakeInput({
  value,
  onChange,
  label,
  quick = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  quick?: boolean;
}) {
  const invalid = value !== '' && parseStake(value) === null;
  return (
    <div className="mt-2 space-y-2">
      <div className="relative">
        <input
          inputMode="decimal"
          autoComplete="off"
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder="0,00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="tabular h-10 w-full rounded-md border border-border-strong bg-surface-2 pl-3 pr-16 text-right text-sm font-semibold text-fg placeholder:text-fg-subtle focus-visible:border-accent focus-visible:outline-none aria-[invalid]:border-down/70"
          data-testid="stake-input"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">
          DEMO
        </span>
      </div>
      {quick ? (
        <div className="grid grid-cols-4 gap-1.5">
          {QUICK_STAKES.map((s) => (
            <button
              key={s}
              onClick={() => onChange(String(s / 100).replace('.', ','))}
              className="tabular rounded-md border border-border bg-surface-2 py-1 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
            >
              {s / 100}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
