'use client';

import type { Card as PlayingCardDto, CasinoPlayResponse } from '@storm-bet/types';
import { Button, Card, cn, toast } from '@storm-bet/ui';
import { Minus, Plus } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { uuid } from '@/lib/uuid';
import { announceWalletChange } from '../providers/session';

/**
 * Sends one round request. The server decides the outcome; the client only
 * says what it bets. A request that failed in transit is retried with the same
 * idempotency key, so it can never be booked twice.
 */
export function useCasinoPlay(gameId: string, sessionId: string) {
  const [busy, setBusy] = useState(false);
  const failed = useRef<{ body: string; key: string } | null>(null);
  const play = useCallback(
    async (body: Record<string, unknown>): Promise<CasinoPlayResponse | null> => {
      const json = JSON.stringify(body);
      const key = failed.current?.body === json ? failed.current.key : uuid();
      setBusy(true);
      try {
        const res = await api<CasinoPlayResponse>(`/casino/games/${gameId}/play`, {
          body: { ...body, sessionId, idempotencyKey: key },
        });
        failed.current = null;
        announceWalletChange();
        return res;
      } catch (error) {
        failed.current = error instanceof ApiError ? null : { body: json, key };
        toast.error(errorMessage(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [gameId, sessionId],
  );
  return { play, busy };
}

/** Balance and game info, positioned by GameShell next to (desktop) or below (mobile) the game. */
export const GameSideContext = createContext<{ balance: React.ReactNode; info: React.ReactNode }>({
  balance: null,
  info: null,
});

/** Desktop: game area | balance, controls, info. Mobile: area, balance, controls, info. */
export function GameShell({
  area,
  controls,
}: {
  area: React.ReactNode;
  controls: React.ReactNode;
}) {
  const side = useContext(GameSideContext);
  const areaRef = useRef<HTMLDivElement>(null);
  // On a phone the controls sit below the game: bring the game back into view
  // when a round starts, so the player sees it play out.
  const showArea = (e: React.MouseEvent) => {
    const area = areaRef.current;
    if (!area || !(e.target as Element).closest('[data-play]')) return;
    if (area.getBoundingClientRect().top >= 80) return;
    // After React's commit, which may refocus (and so scroll to) the button.
    requestAnimationFrame(() => area.scrollIntoView({ behavior: 'smooth' }));
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" onClickCapture={showArea}>
      <Card
        ref={areaRef}
        className="scroll-mt-20 overflow-hidden lg:row-span-3 lg:[&>*]:h-full"
        data-testid="game-area"
      >
        {area}
      </Card>
      {side.balance}
      <Card className="space-y-4 p-4" data-testid="game-controls">
        {controls}
      </Card>
      {side.info}
    </div>
  );
}

const CHIPS = [10, 50, 100, 200, 500, 1_000, 2_500, 5_000, 10_000];

export function StakeControl({
  value,
  onChange,
  min,
  max,
  disabled,
  label = 'Einsatz',
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
  label?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const chips = CHIPS.filter((c) => c >= min && c <= max);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{label}</span>
        <span>
          {formatMoney(min)} – {formatMoney(max)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          aria-label="Einsatz halbieren"
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(Math.floor(value / 2)))}
        >
          <Minus />
        </Button>
        <p className="tabular flex-1 text-center text-lg font-semibold" data-testid="stake">
          {formatMoney(value)}
        </p>
        <Button
          variant="secondary"
          size="icon"
          aria-label="Einsatz verdoppeln"
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value * 2))}
        >
          <Plus />
        </Button>
      </div>
      <ChipPicker values={chips} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function ChipPicker({
  values,
  value,
  onChange,
  disabled,
}: {
  values: number[];
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Chip-Wert">
      {values.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value === c}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={cn(
            'tabular rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
            value === c
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-border-strong bg-surface-2 text-fg-muted hover:text-fg',
          )}
        >
          {formatMoney(c, { unit: false })}
        </button>
      ))}
    </div>
  );
}

const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' } as const;

export function PlayingCard({ card, index = 0 }: { card: PlayingCardDto | null; index?: number }) {
  if (!card) {
    return (
      <div
        className="h-24 w-16 rounded-lg border border-white/10 bg-[repeating-linear-gradient(45deg,#1d4ed8,#1d4ed8_6px,#1e3a8a_6px,#1e3a8a_12px)] shadow-md sm:h-28 sm:w-20"
        aria-label="Verdeckte Karte"
      />
    );
  }
  const red = card.suit === 'H' || card.suit === 'D';
  return (
    <div
      className={cn(
        'flex h-24 w-16 flex-col justify-between rounded-lg bg-white p-1.5 shadow-md animate-slide-up sm:h-28 sm:w-20',
        red ? 'text-red-600' : 'text-slate-900',
      )}
      style={{ animationDelay: `${index * 80}ms` }}
      aria-label={`${card.rank}${SUIT[card.suit]}`}
    >
      <span className="text-sm font-bold leading-none">
        {card.rank}
        {SUIT[card.suit]}
      </span>
      <span className="self-center text-3xl leading-none">{SUIT[card.suit]}</span>
      <span className="rotate-180 text-sm font-bold leading-none">
        {card.rank}
        {SUIT[card.suit]}
      </span>
    </div>
  );
}

export function Hand({
  label,
  cards,
  total,
}: {
  label: string;
  cards: (PlayingCardDto | null)[];
  total: number | null;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-white/70">
        {label}
        {total !== null ? <span className="tabular ml-2 text-white">{total}</span> : null}
      </p>
      <div className="flex min-h-24 gap-2 sm:min-h-28">
        {cards.map((c, i) => (
          <PlayingCard key={i} card={c} index={i} />
        ))}
      </div>
    </div>
  );
}

export function Felt({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative min-h-[320px] bg-[radial-gradient(ellipse_at_top,#166534,#052e16)] p-5 sm:p-8',
        className,
      )}
    >
      {children}
    </div>
  );
}
