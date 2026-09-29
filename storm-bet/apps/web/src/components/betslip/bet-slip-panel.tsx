'use client';

import { Dialog, DialogTitle, SheetContent } from '@storm-bet/ui';
import { ChevronUp, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatOdds } from '@/lib/format';
import { effectiveMode, useBetSlip } from '@/stores/bet-slip';
import { BetSlip } from './bet-slip';

/** Desktop: sticky right column. */
export function BetSlipPanel() {
  const count = useBetSlip((s) => s.items.length);
  return (
    <aside
      aria-label="Wettschein"
      className="sticky top-[4.5rem] hidden max-h-[calc(100dvh-5.5rem)] w-full flex-col overflow-hidden rounded-lg border border-border bg-surface lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Ticket className="size-4 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Wettschein</h2>
        {count ? (
          <span className="tabular ml-auto rounded bg-accent-soft px-1.5 text-xs font-semibold text-accent-strong">
            {count}
          </span>
        ) : null}
      </div>
      <BetSlip className="min-h-0 flex-1" />
    </aside>
  );
}

/** Mobile: sticky bottom bar that opens the slip as a sheet. */
export function MobileBetSlipBar() {
  const items = useBetSlip((s) => s.items);
  const mode = useBetSlip((s) => s.mode);
  const open = useBetSlip((s) => s.open);
  const setOpen = useBetSlip((s) => s.setOpen);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const combo = effectiveMode(items, mode) === 'COMBO';
  const total = items.reduce((acc, i) => (acc * Math.round(i.odds * 1000)) / 1000, 1);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {items.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
          <button
            onClick={() => setOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg bg-accent px-4 py-3 text-accent-fg shadow-[var(--shadow-pop)] animate-slide-up"
            data-testid="mobile-slip-button"
          >
            <span className="grid size-7 place-items-center rounded-full bg-accent-fg/15 text-sm font-bold">
              {items.length}
            </span>
            <span className="text-sm font-semibold">Wettschein</span>
            {combo ? (
              <span className="tabular ml-auto text-sm font-semibold">
                Quote {formatOdds(total)}
              </span>
            ) : (
              <span className="ml-auto" />
            )}
            <ChevronUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <SheetContent className="flex flex-col lg:hidden" aria-describedby={undefined}>
        <DialogTitle className="px-4 pb-2 pt-3 text-sm">Wettschein</DialogTitle>
        <BetSlip className="min-h-0 flex-1" />
      </SheetContent>
    </Dialog>
  );
}
