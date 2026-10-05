'use client';

import { Button } from '@storm-bet/ui';
import { ArrowRight, Plus, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatMoney } from '@/lib/format';
import { useSession } from '../providers/session';

/** Starting credit (guests) or the live demo balance (players) – play money, clearly labelled. */
export function BalanceCard({ startCredit }: { startCredit: number }) {
  const t = useT();
  const { user, wallet } = useSession();
  const amount = user ? (wallet ? formatMoney(wallet.available) : '—') : formatMoney(startCredit);
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-accent/20 bg-surface bg-brand-soft"
      aria-label={t('Demo-Guthaben')}
      data-testid="balance-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:p-5">
        <div className="min-w-[9.5rem] flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-accent-strong">
            {user ? t('Dein Demo-Guthaben') : t('Startguthaben')}
          </p>
          <p className="tabular mt-1 text-[28px] font-extrabold leading-none tracking-tight sm:text-[32px]">
            {amount}
          </p>
          <p className="mt-2 text-xs leading-snug text-fg-muted">
            <span className="block">{t('Spielgeld ohne Geldwert')}</span>
            <span className="block text-fg-subtle">{t('nicht einzahlbar · nicht auszahlbar')}</span>
          </p>
        </div>
        {user ? (
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button size="sm" variant="outline" asChild>
              <Link href="/dashboard/bets">
                <Receipt /> {t('Meine Wetten')}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/dashboard/wallet">
                <Plus /> {t('Aufladen')}
              </Link>
            </Button>
          </div>
        ) : (
          <Button className="max-[359px]:w-full" asChild>
            <Link href="/register" data-testid="balance-cta">
              {t('Kostenlos testen')} <ArrowRight />
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
