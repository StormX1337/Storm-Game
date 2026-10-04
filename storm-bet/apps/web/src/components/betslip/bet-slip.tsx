'use client';

import type {
  ErrorCode,
  PlaceBetResponse,
  SlipIssueDto,
  SlipMode,
  ValidateSlipResponse,
} from '@storm-bet/types';
import { Button, Checkbox, cn, EmptyState, toast } from '@storm-bet/ui';
import { AlertTriangle, Lock, Ticket, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { formatKickoff, formatMoney, formatOdds, parseStake } from '@/lib/format';
import {
  binomial,
  effectiveMode,
  sameEvent,
  systemPossible,
  systemSizeFor,
  useBetSlip,
  type SlipItem,
} from '@/stores/bet-slip';
import { useLive } from '@/stores/live';
import { announceWalletChange, useSession } from '../providers/session';
import { useRealtimeTopics } from '../providers/realtime';
import { SportIcon } from '../sportsbook/sport-icon';
import { ShareButton } from './share-button';
import { SaveSlipButton, SlipShortcuts } from './slip-shortcuts';
import { useT } from '@/i18n/client';

/** Quick stakes add to the typed amount (minor units). */
const QUICK_ADD = [200, 1000, 5000];
const stakeText = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
const MODE_LABELS: Record<SlipMode, string> = {
  COMBO: 'Kombi',
  BUILDER: 'Bet Builder',
  SINGLES: 'Einzelwetten',
  SYSTEM: 'System',
};
/**
 * Issues that make placing pointless until the slip changes. Suspensions and
 * price moves are not listed: they follow the live status of each selection.
 */
const BLOCKING: ErrorCode[] = [
  'VALIDATION_ERROR',
  'BET_LIMIT_EXCEEDED',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'FORBIDDEN',
];

/** `builderOdds`: the Bet Builder price the player accepted; left out of quotes. */
function slipPayload(
  items: SlipItem[],
  mode: SlipMode,
  comboStake: string,
  singleStakes: Record<string, string>,
  acceptHigher: boolean,
  systemSize: number,
  builderOdds: number | null = null,
) {
  const policy = acceptHigher ? 'ACCEPT_HIGHER' : 'REJECT';
  if (mode === 'SYSTEM') {
    return {
      mode,
      size: systemSizeFor(items, systemSize),
      stake: parseStake(comboStake) ?? 0,
      oddsChangePolicy: policy,
      selections: items.map((i) => ({ selectionId: i.selectionId, odds: i.odds })),
    } as const;
  }
  if (mode === 'BUILDER') {
    return {
      mode,
      stake: parseStake(comboStake) ?? 0,
      oddsChangePolicy: policy,
      selections: items.map((i) => ({ selectionId: i.selectionId })),
      ...(builderOdds ? { odds: builderOdds } : {}),
    } as const;
  }
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
  mode: SlipMode,
  comboStake: string,
  singleStakes: Record<string, string>,
  systemSize: number,
) {
  // The Bet Builder price comes from the server's model only.
  if (mode === 'BUILDER')
    return { totalOdds: 0, stake: parseStake(comboStake) ?? 0, potentialReturn: 0 };
  if (mode === 'SYSTEM') {
    const size = systemSizeFor(items, systemSize);
    const unit = parseStake(comboStake) ?? 0;
    const lines = binomial(items.length, size);
    let potentialReturn = 0;
    let sum = 0;
    const walk = (from: number, left: number, milli: bigint) => {
      if (left === 0) {
        sum += Number(milli);
        potentialReturn += Math.floor((unit * Number(milli)) / 1000);
        return;
      }
      for (let i = from; i <= items.length - left; i += 1) {
        walk(i + 1, left - 1, (milli * BigInt(Math.round(items[i]!.odds * 1000))) / 1000n);
      }
    };
    walk(0, size, 1000n);
    return {
      totalOdds: lines ? Math.floor(sum / lines) / 1000 : 0,
      stake: unit * lines,
      potentialReturn,
    };
  }
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
  const t = useT();
  const slip = useBetSlip();
  const { user, wallet } = useSession();
  const pathname = usePathname();
  const mode = effectiveMode(slip.items, slip.mode);
  const [quote, setQuote] = useState<ValidateSlipResponse | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PlaceBetResponse | null>(null);
  /** The payload the current quote answers. */
  const [quotedKey, setQuotedKey] = useState('');
  /** Bumped to ask for a fresh quote with an unchanged slip. */
  const [refresh, setRefresh] = useState(0);
  /** The Bet Builder price the player has seen for these legs. */
  const [builderSeen, setBuilderSeen] = useState<{ legs: string; odds: number } | null>(null);
  const requestId = useRef(0);

  useRealtimeTopics(slip.items.map((i) => `event:${i.eventId}`));

  const payload = useMemo(
    () =>
      slipPayload(
        slip.items,
        mode,
        slip.comboStake,
        slip.singleStakes,
        slip.acceptHigher,
        slip.systemSize,
      ),
    [slip.items, mode, slip.comboStake, slip.singleStakes, slip.acceptHigher, slip.systemSize],
  );
  // Status updates change `items` without changing what is sent; key on content.
  const payloadKey = JSON.stringify(payload);
  // A Bet Builder price depends on the legs' prices: re-quote when they move.
  const priceKey =
    mode === 'BUILDER' ? slip.items.map((i) => i.pendingOdds ?? i.odds).join(',') : '';
  const legsKey = slip.items
    .map((i) => i.selectionId)
    .sort()
    .join(',');

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
        setQuotedKey(payloadKey);
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
  }, [payloadKey, priceKey, refresh]);

  const quoteCurrent = quote !== null && quotedKey === payloadKey;
  const builderQuote =
    mode === 'BUILDER' && quoteCurrent && quote.quote.betType === 'BET_BUILDER'
      ? quote.quote.totalOdds
      : null;
  // The first price for a set of legs is what the player sees; later moves need a look.
  useEffect(() => {
    if (builderQuote === null) return;
    setBuilderSeen((seen) =>
      seen && seen.legs === legsKey ? seen : { legs: legsKey, odds: builderQuote },
    );
  }, [builderQuote, legsKey]);
  const seenOdds = mode === 'BUILDER' && builderSeen?.legs === legsKey ? builderSeen.odds : null;

  const estimate = localQuote(
    slip.items,
    mode,
    slip.comboStake,
    slip.singleStakes,
    slip.systemSize,
  );
  const totalOdds =
    mode === 'BUILDER'
      ? (builderQuote ?? 0)
      : quote?.quote.mode === mode && (mode === 'COMBO' || mode === 'SYSTEM')
        ? quote.quote.totalOdds
        : estimate.totalOdds;
  const potentialReturn =
    quote?.quote.mode === mode ? quote.quote.potentialReturn : estimate.potentialReturn;
  const totalStake = estimate.stake;
  const systemSize = systemSizeFor(slip.items, slip.systemSize);
  const systemLines = mode === 'SYSTEM' ? binomial(slip.items.length, systemSize) : 0;
  // The highest stake the limits allow at this price, within the available balance.
  const maxStake = (() => {
    const caps = [wallet?.available, quote?.quote.maxStake].filter(
      (v): v is number => typeof v === 'number',
    );
    return caps.length ? Math.max(0, Math.min(...caps)) : null;
  })();
  // With the opt-in, a higher price is taken by the server (bounded there);
  // only a lower one needs the player's explicit acceptance. A Bet Builder
  // has one price: only that one counts, not the legs'.
  const takesHigher = (from: number, to: number) => slip.acceptHigher && to > from;
  const changed = mode === 'BUILDER' ? [] : slip.items.filter((i) => i.pendingOdds != null);
  const lowered = changed.filter((i) => !takesHigher(i.odds, i.pendingOdds!));
  const builderChanged = builderQuote !== null && seenOdds !== null && builderQuote !== seenOdds;
  const builderToAccept = builderChanged && !takesHigher(seenOdds, builderQuote);
  const toAccept = mode === 'BUILDER' ? (builderToAccept ? 1 : 0) : lowered.length;
  const raised =
    mode === 'BUILDER'
      ? builderChanged && !builderToAccept
        ? 1
        : 0
      : changed.length - lowered.length;
  const blocked = slip.items.filter((i) => i.status !== 'OPEN');
  const issues: SlipIssueDto[] = (quoteCurrent ? quote.issues : []).filter(
    (i) => i.code !== 'ODDS_CHANGED',
  );
  const blocking = issues.some((i) => BLOCKING.includes(i.code));
  const insufficient = wallet ? totalStake > wallet.available : false;
  const ready =
    !!user &&
    slip.items.length > 0 &&
    totalStake > 0 &&
    blocked.length === 0 &&
    !blocking &&
    (mode !== 'BUILDER' || builderQuote !== null) &&
    !placing &&
    !insufficient;
  const canPlace = ready && toAccept === 0;

  const acceptChanges = () => {
    slip.acceptChanges();
    if (builderQuote !== null) setBuilderSeen({ legs: legsKey, odds: builderQuote });
  };

  /**
   * `acceptFirst`: the player confirmed the changed prices with this click —
   * live prices move every few seconds, so accepting and placing is one step.
   */
  const place = async (acceptFirst = false) => {
    if (!(acceptFirst ? ready : canPlace)) return;
    if (acceptFirst) acceptChanges();
    setPlacing(true);
    setError(null);
    try {
      // Read the store directly: after accepting, this render's payload is stale.
      const s = useBetSlip.getState();
      const body = slipPayload(
        s.items,
        effectiveMode(s.items, s.mode),
        s.comboStake,
        s.singleStakes,
        s.acceptHigher,
        s.systemSize,
        acceptFirst ? builderQuote : seenOdds,
      );
      const idempotencyKey = s.ensureKey();
      const result = await api<PlaceBetResponse>('/bets/place', {
        body: { ...body, idempotencyKey },
      });
      setReceipt(result);
      slip.clear();
      announceWalletChange(result.wallet);
      toast.success(
        result.bets.length > 1
          ? t('{0} Wetten platziert', [result.bets.length])
          : t('Wette platziert · {0}', [result.bets[0]?.reference ?? '']),
      );
      onPlaced?.();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'ODDS_CHANGED') {
        const list = (err.details?.issues as SlipIssueDto[] | undefined) ?? [];
        for (const i of list) {
          if (i.selectionId && i.currentOdds) slip.observe(i.selectionId, i.currentOdds, 'OPEN');
        }
        // A moved Bet Builder price arrives with the next quote.
        setRefresh((n) => n + 1);
      }
      // A definitive answer ends this submission; the next attempt is a new slip.
      if (err && err.code !== 'SERVICE_UNAVAILABLE' && err.code !== 'INTERNAL_ERROR')
        slip.resetKey();
      setError(err?.message ?? t('Die Wette konnte nicht platziert werden.'));
    } finally {
      setPlacing(false);
    }
  };

  if (receipt) {
    return (
      <div className={cn('flex flex-col', className)} data-testid="bet-receipt">
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-up/30 bg-up-soft p-4">
            <p className="text-sm font-semibold text-up">{t('Wette angenommen')}</p>
            <p className="mt-1 text-xs text-fg-muted">
              {t('Dein Einsatz ist reserviert. Die Abrechnung erfolgt automatisch nach Spielende.')}
            </p>
          </div>
          {receipt.bets.map((bet) => (
            <div key={bet.id} className="rounded-md border border-border bg-surface-2 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-fg-muted">{bet.reference}</span>
                <span className="tabular font-semibold">{formatOdds(bet.totalOdds)}</span>
              </div>
              {bet.system ? (
                <p className="mt-1 text-xs text-fg-muted">
                  {t('Systemwette')} {bet.system.size} aus {bet.selections.length} ·{' '}
                  {bet.system.lines} {t('Wetten')}
                </p>
              ) : null}
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between text-fg-muted">
                  <dt>{t('Einsatz')}</dt>
                  <dd className="tabular">{formatMoney(bet.stake)}</dd>
                </div>
                <div className="flex justify-between text-fg-muted">
                  <dt>{t('Möglicher Gewinn')}</dt>
                  <dd className="tabular font-semibold text-up">
                    {formatMoney(bet.potentialReturn)}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setReceipt(null)}>
              {t('Weiter wetten')}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/dashboard/bets">{t('Meine Wetten')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (slip.items.length === 0) {
    return (
      <div className={cn('overflow-y-auto', className)}>
        <EmptyState
          icon={<Ticket />}
          title={t('Dein Wettschein ist leer')}
          description={t('Tippe auf eine Quote, um eine Auswahl hinzuzufügen.')}
        />
        <SlipShortcuts />
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="bet-slip">
      {slip.items.length > 1 ? (
        <div
          className={cn(
            'grid gap-1 border-b border-border p-2',
            systemPossible(slip.items) ? 'grid-cols-3' : 'grid-cols-2',
          )}
          role="tablist"
          aria-label={t('Wettart')}
        >
          {(
            [
              sameEvent(slip.items) ? 'BUILDER' : 'COMBO',
              ...(systemPossible(slip.items) ? (['SYSTEM'] as const) : []),
              'SINGLES',
            ] as const
          ).map((m) => (
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
              {t(MODE_LABELS[m])}
            </button>
          ))}
        </div>
      ) : null}

      {mode === 'BUILDER' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <BuilderCard
            items={slip.items}
            odds={totalOdds}
            onRemove={slip.remove}
            onClear={slip.clear}
          />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {slip.items.map((item) => (
            <li key={item.selectionId} className="p-3" data-testid="slip-item">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{t(item.selectionName)}</p>
                  <p className="truncate text-xs text-fg-muted">{t(item.marketName)}</p>
                  <p className="truncate text-xs text-fg-subtle">
                    {item.isLive ? (
                      <span className="mr-1 font-semibold text-live">LIVE</span>
                    ) : null}
                    {item.eventName}
                  </p>
                </div>
                <div className="text-right">
                  {item.status !== 'OPEN' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                      <Lock className="size-3" /> {t('Gesperrt')}
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
                  aria-label={t('{0} entfernen', [t(item.selectionName)])}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {mode === 'SINGLES' ? (
                <StakeInput
                  value={slip.singleStakes[item.selectionId] ?? ''}
                  onChange={(v) => slip.setSingleStake(item.selectionId, v)}
                  label={t('Einsatz für {0}', [item.selectionName])}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 border-t border-border p-3">
        {toAccept > 0 ? (
          <div
            className="rounded-md border border-warning/30 bg-warning-soft p-3"
            role="alert"
            data-testid="odds-changed"
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
              <AlertTriangle className="size-4" /> {t('Quote wurde aktualisiert.')}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {mode === 'BUILDER'
                ? t('Bet-Builder-Quote: {0} → {1}.', [
                    formatOdds(seenOdds ?? 0),
                    formatOdds(builderQuote ?? 0),
                  ])
                : t('{0} sich geändert.', [
                    lowered.length === 1
                      ? t('Eine Quote hat')
                      : t('{0} Quoten haben', [lowered.length]),
                  ])}{' '}
              {t('Bitte prüfe und bestätige.')}
            </p>
            {ready ? (
              <Button
                size="sm"
                className="mt-2 w-full"
                onClick={() => void place(true)}
                data-testid="accept-and-place"
              >
                {t('Neue Quoten übernehmen & platzieren')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={acceptChanges}>
                {t('Neue Quoten übernehmen')}
              </Button>
            )}
          </div>
        ) : raised > 0 ? (
          <p className="rounded-md bg-up-soft p-2.5 text-xs text-up" data-testid="odds-raised">
            {t('Quote gestiegen – wird bei Annahme automatisch übernommen.')}
          </p>
        ) : null}
        {blocked.length > 0 ? (
          <p className="rounded-md bg-surface-2 p-2.5 text-xs text-fg-muted">
            {t(
              'Gesperrte Auswahlen können nicht gewettet werden. Entferne sie oder warte, bis der Markt wieder öffnet.',
            )}
          </p>
        ) : null}

        {mode === 'SYSTEM' ? (
          <div className="space-y-1.5">
            <p className="text-xs text-fg-muted">
              {t('System: jede Kombination aus')} {systemSize} von {slip.items.length}{' '}
              {t('Tipps ist eine eigene Wette.')}
            </p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('System')}>
              {Array.from({ length: slip.items.length - 2 }, (_, i) => i + 2).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={systemSize === k}
                  onClick={() => slip.setSystemSize(k)}
                  className={cn(
                    'tabular rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors',
                    systemSize === k
                      ? 'border-accent bg-accent-soft text-fg'
                      : 'border-border text-fg-muted hover:text-fg',
                  )}
                  data-testid="system-size"
                >
                  {k} aus {slip.items.length} · {binomial(slip.items.length, k)} {t('Wetten')}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {mode !== 'SINGLES' ? (
          <StakeInput
            value={slip.comboStake}
            onChange={slip.setComboStake}
            label={mode === 'SYSTEM' ? t('Einsatz pro Wette') : t('Einsatz')}
            quick
            max={
              mode === 'SYSTEM'
                ? wallet && systemLines
                  ? Math.floor(wallet.available / systemLines)
                  : null
                : maxStake
            }
          />
        ) : null}

        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between text-fg-muted">
            <dt>{t('Auswahlen')}</dt>
            <dd className="tabular">{slip.items.length}</dd>
          </div>
          {mode !== 'SINGLES' ? (
            <div className="flex justify-between text-fg-muted">
              <dt>
                {mode === 'BUILDER'
                  ? t('Bet-Builder-Quote')
                  : mode === 'SYSTEM'
                    ? t('Ø Quote pro Wette')
                    : t('Gesamtquote')}
              </dt>
              <dd className="tabular font-semibold text-fg" data-testid="total-odds">
                {totalOdds > 0 ? formatOdds(totalOdds) : '–'}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-fg-muted">
            <dt>{mode === 'SYSTEM' ? t('Einsatz ({0} Wetten)', [systemLines]) : t('Einsatz')}</dt>
            <dd className="tabular">{formatMoney(totalStake)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">
              {mode === 'SYSTEM' ? t('Möglicher Gewinn (alle richtig)') : t('Möglicher Gewinn')}
            </dt>
            <dd className="tabular font-semibold text-up" data-testid="potential-return">
              {formatMoney(potentialReturn)}
            </dd>
          </div>
        </dl>

        <Checkbox
          checked={slip.acceptHigher}
          onChange={(e) => slip.setAcceptHigher(e.target.checked)}
          label={
            <span className="text-xs">
              {t('Höhere Quoten automatisch akzeptieren (max. +10 %)')}
            </span>
          }
        />

        {issues.length > 0 || insufficient || error ? (
          <div className="space-y-1" role="alert">
            {insufficient ? (
              <p className="text-xs text-down">
                {t('Dein verfügbares Demo-Guthaben reicht nicht aus.')}
              </p>
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
            {totalStake > 0
              ? t('Wette platzieren · {0}', [formatMoney(totalStake)])
              : t('Einsatz eingeben')}
          </Button>
        ) : (
          <Button className="w-full" size="lg" asChild>
            <Link href={`/login?next=${encodeURIComponent(pathname)}`}>
              {t('Anmelden, um zu wetten')}
            </Link>
          </Button>
        )}
        <div className="flex items-center justify-between text-xs text-fg-subtle">
          <span>{t('Nur Demo-Guthaben · kein Echtgeld')}</span>
          <span className="flex items-center gap-3">
            <SaveSlipButton />
            <ShareButton selectionIds={slip.items.map((i) => i.selectionId)} />
            <button
              onClick={() => slip.clear()}
              className="inline-flex items-center gap-1 hover:text-fg"
            >
              <Trash2 className="size-3" /> {t('Leeren')}
            </button>
          </span>
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
  max = null,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  quick?: boolean;
  /** Highest allowed stake (minor units), for the MAX button. */
  max?: number | null;
}) {
  const invalid = value !== '' && parseStake(value) === null;
  const quickClass =
    'tabular rounded-md border border-border bg-surface-2 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-40';
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
          €
        </span>
      </div>
      {quick ? (
        <div className="grid grid-cols-4 gap-1.5">
          {QUICK_ADD.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(stakeText((parseStake(value) ?? 0) + s))}
              className={quickClass}
            >
              +{s / 100}
            </button>
          ))}
          <button
            type="button"
            disabled={!max}
            onClick={() => max && onChange(stakeText(max))}
            className={quickClass}
            data-testid="stake-max"
          >
            MAX
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A Bet Builder: one match, its picks as one chain, one price. */
function BuilderCard({
  items,
  odds,
  onRemove,
  onClear,
}: {
  items: SlipItem[];
  odds: number;
  onRemove: (selectionId: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const first = items[0]!;
  return (
    <div
      className="overflow-hidden rounded-lg border border-accent/40 bg-surface-2"
      data-testid="builder-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SportIcon sport={first.sportKey} />
        <span className="text-sm font-semibold text-accent-strong">{t('Bet Builder')}</span>
        <span className="tabular rounded bg-surface-3 px-1.5 py-0.5 text-xs text-fg-muted">
          {items.length} {t('Tipps')}
        </span>
        <span
          className="tabular ml-auto rounded-md bg-surface-3 px-2 py-1 text-sm font-semibold"
          data-testid="builder-odds"
        >
          {odds > 0 ? formatOdds(odds) : '–'}
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label={t('Bet Builder leeren')}
          className="rounded p-1.5 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 text-xs">
        <span className="truncate font-medium text-fg">{first.eventName}</span>
        {items.some((i) => i.isLive) ? (
          <span className="shrink-0 font-semibold text-live">LIVE</span>
        ) : (
          <span className="tabular shrink-0 text-fg-muted">
            {t(formatKickoff(first.startTime))}
          </span>
        )}
      </div>
      <ol className="px-3 pb-2 pt-1.5">
        {items.map((item, i) => (
          <li key={item.selectionId} className="flex gap-3" data-testid="slip-item">
            <span className="flex w-2.5 shrink-0 flex-col items-center pt-1.5" aria-hidden="true">
              <span className="size-2.5 rounded-full border-2 border-accent" />
              {i < items.length - 1 ? <span className="w-px flex-1 bg-accent/40" /> : null}
            </span>
            <div className="min-w-0 flex-1 pb-2.5">
              <p className="truncate text-sm font-semibold">{t(item.selectionName)}</p>
              <p className="truncate text-xs text-fg-muted">{t(item.marketName)}</p>
            </div>
            {item.status !== 'OPEN' ? (
              <Lock className="mt-1 size-3.5 text-warning" aria-label={t('Gesperrt')} />
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(item.selectionId)}
              className="-mr-1 h-fit rounded p-1 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
              aria-label={t('{0} entfernen', [t(item.selectionName)])}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
      <p
        className="border-t border-border px-3 py-2 text-[11px] text-fg-subtle"
        data-testid="builder-info"
      >
        {t(
          'Alle Tipps müssen gewinnen – verliert einer, ist die Wette verloren. Nur wenn ein Tipp annulliert wird (z. B. Spielabsage), gibt es den Einsatz zurück.',
        )}
      </p>
    </div>
  );
}
