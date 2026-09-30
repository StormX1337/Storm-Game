'use client';

import type { SelectionStatus, SlipMode, SportKey } from '@storm-bet/types';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { uuid } from '@/lib/uuid';

export const MAX_SLIP_ITEMS = 20;

export interface SlipItem {
  selectionId: string;
  marketId: string;
  eventId: string;
  eventName: string;
  marketName: string;
  selectionName: string;
  sportKey: SportKey;
  startTime: string;
  /** The price the player has seen and accepted. Sent to the server as-is. */
  odds: number;
  /** A newer price from the server that the player has not accepted yet. */
  pendingOdds: number | null;
  status: SelectionStatus;
  isLive: boolean;
  /** Picked from a market that allows several picks (goalscorers). */
  multi?: boolean;
}

interface SlipState {
  items: SlipItem[];
  mode: SlipMode;
  comboStake: string;
  singleStakes: Record<string, string>;
  acceptHigher: boolean;
  /** Reused for retries of the same submission; reset after a definitive answer. */
  idempotencyKey: string | null;
  open: boolean;

  toggle: (item: Omit<SlipItem, 'pendingOdds' | 'status'> & { status?: SelectionStatus }) => void;
  remove: (selectionId: string) => void;
  clear: () => void;
  /** Adds picks (a shared slip); a pick replaces another of the same market. */
  addMany: (items: Omit<SlipItem, 'pendingOdds'>[]) => void;
  /** Replaces the picks of one match (a suggested Bet Builder). */
  replaceEvent: (eventId: string, items: Omit<SlipItem, 'pendingOdds'>[]) => void;
  setMode: (mode: SlipMode) => void;
  setComboStake: (value: string) => void;
  setSingleStake: (selectionId: string, value: string) => void;
  setAcceptHigher: (value: boolean) => void;
  /** Records a server price; it only becomes the bet price once accepted. */
  observe: (selectionId: string, odds: number, status: SelectionStatus) => void;
  acceptChanges: () => void;
  ensureKey: () => string;
  resetKey: () => void;
  setOpen: (open: boolean) => void;
}

export const useBetSlip = create<SlipState>()(
  persist(
    (set, get) => ({
      items: [],
      mode: 'COMBO',
      comboStake: '',
      singleStakes: {},
      acceptHigher: false,
      idempotencyKey: null,
      open: false,

      toggle: (item) =>
        set((state) => {
          const exists = state.items.some((i) => i.selectionId === item.selectionId);
          if (exists)
            return {
              items: state.items.filter((i) => i.selectionId !== item.selectionId),
              idempotencyKey: null,
            };
          if (state.items.length >= MAX_SLIP_ITEMS) return state;
          // One pick per market: choosing another outcome of the same market replaces it
          // (goalscorer markets allow several).
          const items = item.multi
            ? state.items
            : state.items.filter((i) => i.marketId !== item.marketId);
          return {
            items: [...items, { ...item, status: item.status ?? 'OPEN', pendingOdds: null }],
            idempotencyKey: null,
          };
        }),
      remove: (selectionId) =>
        set((state) => ({
          items: state.items.filter((i) => i.selectionId !== selectionId),
          idempotencyKey: null,
        })),
      clear: () => set({ items: [], comboStake: '', singleStakes: {}, idempotencyKey: null }),
      addMany: (added) =>
        set((state) => {
          let items = state.items;
          for (const item of added) {
            if (items.some((i) => i.selectionId === item.selectionId)) continue;
            if (!item.multi) items = items.filter((i) => i.marketId !== item.marketId);
            items = [...items, { ...item, pendingOdds: null }];
          }
          return { items: items.slice(0, MAX_SLIP_ITEMS), idempotencyKey: null };
        }),
      replaceEvent: (eventId, items) =>
        set((state) => ({
          items: [
            ...state.items.filter((i) => i.eventId !== eventId),
            ...items.map((i) => ({ ...i, pendingOdds: null })),
          ].slice(0, MAX_SLIP_ITEMS),
          idempotencyKey: null,
        })),
      setMode: (mode) => set({ mode, idempotencyKey: null }),
      setComboStake: (comboStake) => set({ comboStake, idempotencyKey: null }),
      setSingleStake: (selectionId, value) =>
        set((state) => ({
          singleStakes: { ...state.singleStakes, [selectionId]: value },
          idempotencyKey: null,
        })),
      setAcceptHigher: (acceptHigher) => set({ acceptHigher, idempotencyKey: null }),
      observe: (selectionId, odds, status) =>
        set((state) => {
          let changed = false;
          const items = state.items.map((i) => {
            if (i.selectionId !== selectionId) return i;
            const pendingOdds = Math.round(odds * 1000) === Math.round(i.odds * 1000) ? null : odds;
            if (i.status === status && i.pendingOdds === pendingOdds) return i;
            changed = true;
            return { ...i, status, pendingOdds };
          });
          return changed ? { items } : state;
        }),
      acceptChanges: () =>
        set((state) => ({
          items: state.items.map((i) =>
            i.pendingOdds == null ? i : { ...i, odds: i.pendingOdds, pendingOdds: null },
          ),
          idempotencyKey: null,
        })),
      ensureKey: () => {
        const existing = get().idempotencyKey;
        if (existing) return existing;
        const key = uuid();
        set({ idempotencyKey: key });
        return key;
      },
      resetKey: () => set({ idempotencyKey: null }),
      setOpen: (open) => set({ open }),
    }),
    {
      name: 'storm-bet-slip',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Prices are re-validated on load; only the selection itself is remembered.
      partialize: (state) => ({
        items: state.items,
        mode: state.mode,
        comboStake: state.comboStake,
        singleStakes: state.singleStakes,
        acceptHigher: state.acceptHigher,
      }),
    },
  ),
);

/** Two or more selections, all from one match: a Bet Builder candidate. */
export function sameEvent(items: SlipItem[]): boolean {
  return items.length > 1 && items.every((i) => i.eventId === items[0]!.eventId);
}

/**
 * The mode actually used: one selection is always a plain bet; several
 * selections of one match combine as a Bet Builder, never as a Kombi (which
 * the book refuses for one match), and a Bet Builder needs one match.
 */
export function effectiveMode(items: SlipItem[], mode: SlipMode): SlipMode {
  if (items.length <= 1) return 'COMBO';
  if (mode === 'SINGLES') return mode;
  return sameEvent(items) ? 'BUILDER' : 'COMBO';
}
