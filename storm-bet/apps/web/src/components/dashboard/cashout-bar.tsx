'use client';

import type { CashoutQuoteDto, CashoutResponse } from '@storm-bet/types';
import { Button, toast } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { cashoutQuote } from '@/lib/cashout';
import { formatMoney } from '@/lib/format';
import { announceWalletChange } from '../providers/session';

const REFRESH_MS = 10_000;

/** Offer to close an open bet at its current value; two clicks, never one. */
export function CashoutBar({ betId }: { betId: string }) {
  const router = useRouter();
  const [quote, setQuote] = useState<CashoutQuoteDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
  if (!quote.available || quote.amount === null) {
    return quote.reason ? (
      <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">{quote.reason}</p>
    ) : null;
  }
  const amount = quote.amount;

  const cashOut = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<CashoutResponse>(`/bets/${betId}/cashout`, { body: { amount } });
      announceWalletChange(result.wallet);
      toast.success(`Cashout: ${formatMoney(result.bet.payout ?? amount)} gutgeschrieben`);
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'ODDS_CHANGED' && typeof err.details?.amount === 'number') {
        setQuote({ ...quote, amount: err.details.amount });
        setNote('Der Wert hat sich geändert. Bitte bestätige den neuen Betrag.');
      } else {
        setConfirming(false);
        setNote(err?.message ?? 'Cashout nicht möglich.');
        void refresh();
      }
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
            Jetzt für <span className="tabular font-semibold text-fg">{formatMoney(amount)}</span>{' '}
            auszahlen?
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
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
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          onClick={() => setConfirming(true)}
          data-testid="cashout-button"
        >
          Cashout <span className="tabular ml-1 font-semibold">{formatMoney(amount)}</span>
        </Button>
      )}
    </div>
  );
}
