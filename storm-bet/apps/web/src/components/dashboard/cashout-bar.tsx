'use client';

import type { CashoutQuoteDto, CashoutResponse } from '@storm-bet/types';
import { Button, toast } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { cashoutQuote } from '@/lib/cashout';
import { formatMoney, parseStake } from '@/lib/format';
import { announceWalletChange } from '../providers/session';

const REFRESH_MS = 10_000;
const PARTS = [25, 50, 75];

/**
 * Offer to close an open bet at its current value — all of it or part of the
 * stake — or automatically once it reaches a target. Two clicks, never one.
 */
export function CashoutBar({ betId }: { betId: string }) {
  const router = useRouter();
  const [quote, setQuote] = useState<CashoutQuoteDto | null>(null);
  /** The stake part being confirmed (null: all of it). */
  const [confirming, setConfirming] = useState<{ part: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoValue, setAutoValue] = useState('');

  const refresh = useCallback(async () => {
    const q = await cashoutQuote(betId);
    setQuote(q);
    return q;
  }, [betId]);

  useEffect(() => {
    void refresh();
    // While confirming, the offer stays fixed until the player answers.
    if (confirming) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, confirming]);

  if (!quote) return null;
  const autoLine =
    quote.autoCashout !== null ? (
      <p className="flex items-center gap-2 text-xs text-fg-muted" data-testid="auto-cashout">
        Auto-Cashout bei ≥ {formatMoney(quote.autoCashout)}
        <button
          type="button"
          className="text-fg-subtle underline hover:text-fg"
          onClick={() => void saveAuto(null)}
        >
          Entfernen
        </button>
      </p>
    ) : null;
  if (!quote.available || quote.amount === null) {
    return quote.reason || autoLine ? (
      <div className="space-y-1 border-t border-border px-4 py-2">
        {quote.reason ? <p className="text-xs text-fg-subtle">{quote.reason}</p> : null}
        {autoLine}
      </div>
    ) : null;
  }
  const amount = quote.amount;
  const partValue = (part: number) => Math.floor((amount * part) / quote.remainingStake);
  const offer = confirming?.part == null ? amount : partValue(confirming.part);

  async function saveAuto(value: number | null) {
    try {
      await api(`/bets/${betId}/auto-cashout`, { method: 'PUT', body: { amount: value } });
      setAutoOpen(false);
      setAutoValue('');
      toast.success(value === null ? 'Auto-Cashout entfernt' : 'Auto-Cashout gespeichert');
      void refresh();
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  const cashOut = async () => {
    setBusy(true);
    setNote(null);
    try {
      const part = confirming?.part ?? undefined;
      const result = await api<CashoutResponse>(`/bets/${betId}/cashout`, {
        body: { amount: offer, ...(part ? { part } : {}) },
      });
      announceWalletChange(result.wallet);
      toast.success(`${part ? 'Teil-Cashout' : 'Cashout'}: ${formatMoney(offer)} gutgeschrieben`);
      setConfirming(null);
      router.refresh();
      void refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'ODDS_CHANGED') {
        setNote('Der Wert hat sich geändert. Bitte prüfe den neuen Betrag.');
        setConfirming(null);
      } else {
        setConfirming(null);
        setNote(err?.message ?? 'Cashout nicht möglich.');
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border px-4 py-2.5" data-testid="cashout">
      {note ? <p className="text-xs text-warning">{note}</p> : null}
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-fg-muted">
            {confirming.part ? 'Teil-Cashout' : 'Cashout'}:{' '}
            <span className="tabular font-semibold text-fg">{formatMoney(offer)}</span> auszahlen?
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            onClick={() => void cashOut()}
            loading={busy}
            data-testid="cashout-confirm"
          >
            Bestätigen
          </Button>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            onClick={() => setConfirming({ part: null })}
            data-testid="cashout-button"
          >
            Cashout <span className="tabular ml-1 font-semibold">{formatMoney(amount)}</span>
          </Button>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <span>Teil-Cashout:</span>
            {PARTS.map((pct) => {
              const part = Math.floor((quote.remainingStake * pct) / 100);
              if (part <= 0 || partValue(part) <= 0) return null;
              return (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setConfirming({ part })}
                  className="tabular rounded border border-border px-2 py-0.5 hover:border-border-strong hover:text-fg"
                  data-testid={`cashout-part-${pct}`}
                >
                  {pct} % · {formatMoney(partValue(part))}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setAutoOpen((v) => !v)}
              className="ml-auto underline hover:text-fg"
              data-testid="auto-cashout-toggle"
            >
              Auto-Cashout
            </button>
          </div>
          {autoOpen ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const value = parseStake(autoValue);
                if (value) void saveAuto(value);
              }}
            >
              <input
                inputMode="decimal"
                placeholder={`Zielwert, z. B. ${formatMoney(Math.ceil(amount * 1.2))}`}
                value={autoValue}
                onChange={(e) => setAutoValue(e.target.value)}
                aria-label="Auto-Cashout-Zielwert"
                className="tabular h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-2 text-xs focus-visible:border-accent focus-visible:outline-none"
                data-testid="auto-cashout-input"
              />
              <Button size="sm" type="submit" data-testid="auto-cashout-save">
                Speichern
              </Button>
            </form>
          ) : null}
          {autoLine}
        </>
      )}
    </div>
  );
}
