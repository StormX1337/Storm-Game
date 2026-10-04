'use client';

import type { BetDto, Paginated, SavedSlipDto, SharedSelectionDto } from '@storm-bet/types';
import { cn, toast } from '@storm-bet/ui';
import { Bookmark, History, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney, formatRelative } from '@/lib/format';
import { BET_TYPE_LABELS } from '@/lib/labels';
import { useBetSlip, type SlipItem } from '@/stores/bet-slip';
import { useSession } from '../providers/session';

export const SAVED_SLIPS_CHANGED = 'storm-bet:saved-slips-changed';
const stakeText = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');

/** A pick as the slip keeps it, at the price the server reports now. */
export function toSlipItem(s: SharedSelectionDto): Omit<SlipItem, 'pendingOdds'> {
  return {
    selectionId: s.selectionId,
    marketId: s.marketId,
    eventId: s.eventId,
    eventName: s.eventName,
    marketName: s.marketName,
    selectionName: s.selectionName,
    sportKey: s.sportKey,
    startTime: s.startTime,
    odds: s.odds,
    status: 'OPEN',
    isLive: s.isLive,
    multi: s.marketType === 'PLAYER_TO_SCORE',
  };
}

async function currentSelections(ids: string[]) {
  const res = await api<{ selections: SharedSelectionDto[] }>(
    `/selections?ids=${encodeURIComponent(ids.join(','))}`,
  );
  return res.selections;
}

/** Saves the picks on the slip under a name taken from the first match. */
export function SaveSlipButton() {
  const t = useT();
  const { user } = useSession();
  const items = useBetSlip((s) => s.items);
  const [busy, setBusy] = useState(false);
  if (!user || items.length === 0) return null;
  const save = async () => {
    setBusy(true);
    const first = items[0]!;
    const name = `${first.eventName}${items.length > 1 ? ` +${items.length - 1}` : ''}`;
    try {
      await api('/slips/saved', {
        body: {
          name: name.length > 40 ? `${name.slice(0, 39)}…` : name,
          selectionIds: items.map((i) => i.selectionId),
        },
      });
      window.dispatchEvent(new Event(SAVED_SLIPS_CHANGED));
      toast.success(t('Wettschein gespeichert'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void save()}
      disabled={busy}
      className="inline-flex items-center gap-1 hover:text-fg disabled:opacity-60"
      data-testid="save-slip"
    >
      <Bookmark className="size-3" /> {t('Speichern')}
    </button>
  );
}

interface LastBet {
  bet: BetDto;
  open: SharedSelectionDto[];
}

/**
 * The last bet again, and saved slips. Shown on the empty slip and on
 * "Meine Wetten"; `afterLoad` takes the player to the slip from pages without one.
 */
export function SlipShortcuts({
  className = 'px-3 pb-4',
  afterLoad,
}: {
  className?: string;
  afterLoad?: () => void;
}) {
  const t = useT();
  const { user } = useSession();
  const [last, setLast] = useState<LastBet | null>(null);
  const [saved, setSaved] = useState<SavedSlipDto[]>([]);
  const [all, setAll] = useState(false);

  const loadSaved = useCallback(() => {
    api<{ slips: SavedSlipDto[] }>('/slips/saved')
      .then((r) => setSaved(r.slips))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    loadSaved();
    void (async () => {
      try {
        const bets = await api<Paginated<BetDto>>('/bets?limit=1');
        const bet = bets.items[0];
        if (!bet) return;
        const current = await currentSelections(bet.selections.map((s) => s.selectionId));
        const open = current.filter((s) => s.open);
        if (alive && open.length) setLast({ bet, open });
      } catch {
        // Shortcuts are optional; the empty slip still works.
      }
    })();
    window.addEventListener(SAVED_SLIPS_CHANGED, loadSaved);
    return () => {
      alive = false;
      window.removeEventListener(SAVED_SLIPS_CHANGED, loadSaved);
    };
  }, [user, loadSaved]);

  if (!user || (!last && saved.length === 0)) return null;

  const repeat = ({ bet, open }: LastBet) => {
    const slip = useBetSlip.getState();
    slip.addMany(open.map(toSlipItem));
    // One pick or a Kombi/Bet Builder: one stake; a system bet: the stake per line.
    if (bet.system) {
      slip.setMode('SYSTEM');
      slip.setSystemSize(bet.system.size);
      slip.setComboStake(stakeText(Math.floor(bet.stake / bet.system.lines)));
    } else {
      slip.setMode('COMBO');
      slip.setComboStake(stakeText(bet.stake));
    }
    const missing = bet.selections.length - open.length;
    if (missing > 0)
      toast.info(
        t('{0} von {1} Tipps sind nicht mehr verfügbar.', [missing, bet.selections.length]),
      );
    afterLoad?.();
  };

  const load = async (s: SavedSlipDto) => {
    try {
      const open = (await currentSelections(s.selectionIds)).filter((x) => x.open);
      if (open.length === 0) {
        toast.error(t('Keiner dieser Tipps ist noch offen.'));
        return;
      }
      useBetSlip.getState().addMany(open.map(toSlipItem));
      const missing = s.selectionIds.length - open.length;
      if (missing > 0)
        toast.info(
          t('{0} von {1} Tipps sind nicht mehr verfügbar.', [missing, s.selectionIds.length]),
        );
      afterLoad?.();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (s: SavedSlipDto) => {
    try {
      await api(`/slips/saved/${s.id}`, { method: 'DELETE' });
      setSaved((list) => list.filter((x) => x.id !== s.id));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const shown = all ? saved : saved.slice(0, 4);
  return (
    <div className={cn('space-y-4', className)}>
      {last ? (
        <button
          type="button"
          onClick={() => repeat(last)}
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-2 p-3 text-left transition-colors hover:border-border-strong"
          data-testid="repeat-last-bet"
        >
          <History className="size-5 shrink-0 text-accent-strong" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{t('Letzte Wette wiederholen')}</span>
            <span className="block truncate text-xs text-fg-muted">
              {t(BET_TYPE_LABELS[last.bet.type])} · {last.open.length}{' '}
              {last.open.length === 1 ? t('Tipp') : t('Tipps')} · {formatMoney(last.bet.stake)}
            </span>
          </span>
        </button>
      ) : null}
      {saved.length ? (
        <section className="space-y-2" aria-labelledby="saved-slips-title">
          <h3 id="saved-slips-title" className="text-xs font-semibold uppercase text-fg-muted">
            {t('Gespeicherte Wettscheine')}
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {shown.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 py-1 pl-3 pr-1"
                data-testid="saved-slip"
              >
                <button
                  type="button"
                  onClick={() => void load(s)}
                  className="min-w-0 flex-1 py-1.5 text-left"
                  data-testid="load-saved-slip"
                >
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="block text-xs text-fg-muted">
                    {s.selectionIds.length} {s.selectionIds.length === 1 ? t('Tipp') : t('Tipps')} ·{' '}
                    {t(formatRelative(s.createdAt))}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(s)}
                  className="grid size-8 place-items-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
                  aria-label={t('Löschen')}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {saved.length > shown.length ? (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="text-xs text-accent hover:underline"
            >
              {t('Alle anzeigen ({0})', [saved.length])}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** On pages without a slip: load, then show the slip on the start page. */
export function BetsPageShortcuts() {
  const router = useRouter();
  return (
    <SlipShortcuts
      className="lg:max-w-md"
      afterLoad={() => {
        useBetSlip.getState().setOpen(true);
        router.push('/');
      }}
    />
  );
}
