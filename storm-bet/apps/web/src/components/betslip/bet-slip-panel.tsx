'use client';

import { Dialog, DialogTitle, SheetContent } from '@storm-bet/ui';
import { ChevronUp, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatOdds } from '@/lib/format';
import { effectiveMode, useBetSlip } from '@/stores/bet-slip';
import { BetSlip } from './bet-slip';
import { useT } from '@/i18n/client';

/** Desktop: sticky right column. */
export function BetSlipPanel() {
  const t = useT();
  const count = useBetSlip((s) => s.items.length);
  return (
    <aside
      aria-label={t('Wettschein')}
      className="sticky top-[4.5rem] hidden max-h-[calc(100dvh-5.5rem)] w-full flex-col overflow-hidden rounded-lg border border-border bg-surface lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Ticket className="size-4 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{t('Wettschein')}</h2>
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
  const t = useT();
  const items = useBetSlip((s) => s.items);
  const mode = useBetSlip((s) => s.mode);
  const open = useBetSlip((s) => s.open);
  const setOpen = useBetSlip((s) => s.setOpen);
  const [mounted, setMounted] = useState(false);
  // From lg the slip is in the sidebar; the sheet (and its overlay) must not open there.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    if (wide && open) setOpen(false);
  }, [wide, open, setOpen]);
  if (!mounted) return null;

  // A Bet Builder has its own (model) price; only a Kombi shows the product here.
  const combo = effectiveMode(items, mode) === 'COMBO';
  const total = items.reduce((acc, i) => (acc * Math.round(i.odds * 1000)) / 1000, 1);

  return (
    <Dialog open={open && !wide} onOpenChange={setOpen}>
      {items.length > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 px-3 pb-1 pt-3 md:bottom-0 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
          <button
            onClick={() => setOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg bg-accent px-4 py-3 text-accent-fg shadow-[var(--shadow-pop)] animate-slide-up"
            data-testid="mobile-slip-button"
          >
            <span className="grid size-7 place-items-center rounded-full bg-accent-fg/15 text-sm font-bold">
              {items.length}
            </span>
            <span className="text-sm font-semibold">{t('Wettschein')}</span>
            {combo ? (
              <span className="tabular ml-auto text-sm font-semibold">
                {t('Quote')} {formatOdds(total)}
              </span>
            ) : (
              <span className="ml-auto" />
            )}
            <ChevronUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <SheetContent className="flex flex-col lg:hidden" aria-describedby={undefined}>
        <DialogTitle className="px-4 pb-2 pt-3 text-sm">{t('Wettschein')}</DialogTitle>
        <BetSlip className="min-h-0 flex-1" />
      </SheetContent>
    </Dialog>
  );
}
