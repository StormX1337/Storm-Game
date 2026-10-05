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
      className="sticky top-[5.5rem] hidden max-h-[calc(100dvh-6.5rem)] w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-card)] lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Ticket className="size-4 text-accent-strong" aria-hidden="true" />
        <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{t('Wettschein')}</h2>
        {count ? (
          <span className="tabular grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold leading-5 text-accent-fg">
            {count}
          </span>
        ) : null}
        <span className="ml-auto rounded-[5px] bg-warning-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-warning">
          {t('Demo')}
        </span>
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
        // Room at the page end, so the floating bar never hides the last content.
        <div aria-hidden="true" className="h-16 lg:hidden" />
      ) : null}
      {items.length > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 px-3 pb-2 pt-2 md:bottom-0 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
          <button
            onClick={() => setOpen(true)}
            className="flex h-12 w-full items-center gap-3 rounded-xl bg-accent px-4 text-accent-fg shadow-[0_10px_30px_-10px_rgb(79_91_255/0.8)] animate-slide-up active:scale-[0.99]"
            data-testid="mobile-slip-button"
          >
            <span className="tabular grid size-7 place-items-center rounded-full bg-white/20 text-sm font-bold">
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
        <div className="flex items-center gap-2 px-4 pb-1 pt-2">
          <DialogTitle className="text-sm font-bold uppercase tracking-[0.08em]">
            {t('Wettschein')}
          </DialogTitle>
          <span className="ml-auto rounded-[5px] bg-warning-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-warning">
            {t('Demo')}
          </span>
        </div>
        <BetSlip className="min-h-0 flex-1" />
      </SheetContent>
    </Dialog>
  );
}
