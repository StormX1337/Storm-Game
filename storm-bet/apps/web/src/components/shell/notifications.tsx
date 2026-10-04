'use client';

import type { BetDto, Paginated } from '@storm-bet/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@storm-bet/ui';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatMoney, formatRelative } from '@/lib/format';
import { BET_STATUS_LABELS } from '@/lib/labels';
import { announceWalletChange } from '../providers/session';
import { useT } from '@/i18n/client';
import type { T } from '@/i18n/translate';

const SEEN_KEY = 'storm-bet:notifications-seen';
const POLL_MS = 30_000;

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function message(bet: BetDto, t: T): string {
  if (bet.status === 'WON')
    return t('Gewonnen: {0} gutgeschrieben', [formatMoney(bet.payout ?? 0)]);
  if (bet.status === 'LOST') return t('Leider verloren');
  return t('{0}: Einsatz {1} erstattet', [
    t(BET_STATUS_LABELS[bet.status]),
    formatMoney(bet.stake),
  ]);
}

/**
 * Settlement notifications. The list is the user's own settled bets from the
 * API (nothing is pushed across users); "read" state is a per-device
 * timestamp. A newly settled bet also raises a toast.
 */
export function NotificationBell() {
  const t = useT();
  const [items, setItems] = useState<BetDto[]>([]);
  const [seen, setSeen] = useState(0);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api<Paginated<BetDto>>('/bets?status=settled&limit=8');
      const fresh = page.items.filter((b) => b.settledAt);
      if (known.current) {
        const arrived = fresh.filter((b) => !known.current!.has(b.id));
        for (const bet of arrived) {
          toast(t('Wette {0} abgerechnet', [bet.reference]), { description: message(bet, t) });
        }
        if (arrived.length) announceWalletChange();
      }
      known.current = new Set(fresh.map((b) => b.id));
      setItems(fresh);
    } catch {
      // Keep the last list; the bell is not critical.
    }
  }, [t]);

  useEffect(() => {
    setSeen(readSeen());
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const unread = items.filter((b) => b.settledAt && Date.parse(b.settledAt) > seen).length;
  const markRead = () => {
    const now = Date.now();
    setSeen(now);
    try {
      localStorage.setItem(SEEN_KEY, String(now));
    } catch {
      // Private mode: unread state simply resets next visit.
    }
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && markRead()}>
      <DropdownMenuTrigger asChild>
        <button
          className="relative grid size-9 place-items-center rounded-full text-white/90 transition-colors hover:bg-white/10 md:text-fg-muted md:hover:bg-surface-2 md:hover:text-fg"
          aria-label={unread ? t('{0} neue Benachrichtigungen', [unread]) : t('Benachrichtigungen')}
        >
          <Bell className="size-4" />
          {unread ? (
            <span className="tabular absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-4 text-white">
              {unread}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t('Abrechnungen')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2.5 py-4 text-center text-sm text-fg-muted">
            {t('Noch keine abgerechneten Wetten.')}
          </p>
        ) : (
          items.map((bet) => (
            <DropdownMenuItem key={bet.id} asChild>
              <Link href={`/dashboard/bets/${bet.id}`} className="flex-col items-start gap-0.5">
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono text-xs text-fg">{bet.reference}</span>
                  <span className="text-[11px] text-fg-subtle">
                    {bet.settledAt ? t(formatRelative(bet.settledAt)) : ''}
                  </span>
                </span>
                <span
                  className={bet.status === 'WON' ? 'text-xs text-up' : 'text-xs text-fg-muted'}
                >
                  {message(bet, t)}
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
