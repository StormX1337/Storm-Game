'use client';

import type { CashoutQuoteDto } from '@storm-bet/types';
import { api } from './api-client';

/**
 * Collects the quote requests of all cashout buttons on a page into one call.
 */
let pending: Map<string, ((q: CashoutQuoteDto | null) => void)[]> | null = null;

export function cashoutQuote(betId: string): Promise<CashoutQuoteDto | null> {
  return new Promise((resolve) => {
    if (!pending) {
      pending = new Map();
      window.setTimeout(flush, 50);
    }
    pending.set(betId, [...(pending.get(betId) ?? []), resolve]);
  });
}

async function flush() {
  const batch = pending!;
  pending = null;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    let quotes: CashoutQuoteDto[] = [];
    try {
      quotes = (
        await api<{ quotes: CashoutQuoteDto[] }>('/bets/cashout/quotes', {
          body: { betIds: chunk },
        })
      ).quotes;
    } catch {
      quotes = [];
    }
    for (const id of chunk) {
      const quote = quotes.find((q) => q.betId === id) ?? null;
      for (const resolve of batch.get(id) ?? []) resolve(quote);
    }
  }
}
