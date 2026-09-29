'use client';

import type {
  EventStatistics,
  EventStatus,
  LiveState,
  MarketStatus,
  Pair,
  RealtimeMessage,
  SelectionStatus,
} from '@storm-bet/types';
import { create } from 'zustand';

export interface LiveSelection {
  odds: number;
  status: SelectionStatus;
  oddsVersion: number;
  direction: 'up' | 'down' | null;
  changedAt: number;
}

export interface LiveEvent {
  status: EventStatus;
  score: Pair | null;
  liveState: LiveState | null;
  statistics: EventStatistics | null;
  isActive: boolean;
}

interface LiveStore {
  selections: Record<string, LiveSelection>;
  markets: Record<string, MarketStatus>;
  events: Record<string, LiveEvent>;
  /** Market ids the page did not know about (new in-play lines) — triggers a refresh. */
  unknownMarkets: number;
  connected: boolean;
  apply: (message: RealtimeMessage) => void;
  setConnected: (connected: boolean) => void;
}

/**
 * Latest pushed state, keyed by id. Components prefer it over the server-
 * rendered value when it is newer (higher oddsVersion). It is a display hint
 * only; the bet slip always revalidates against the API.
 */
export const useLive = create<LiveStore>()((set) => ({
  selections: {},
  markets: {},
  events: {},
  unknownMarkets: 0,
  connected: false,
  setConnected: (connected) => set({ connected }),
  apply: (message) =>
    set((state) => {
      switch (message.type) {
        case 'odds': {
          const selections = { ...state.selections };
          const now = Date.now();
          for (const s of message.selections) {
            const prev = selections[s.id];
            if (prev && prev.oddsVersion >= s.oddsVersion) continue;
            const direction = prev
              ? s.odds > prev.odds
                ? 'up'
                : s.odds < prev.odds
                  ? 'down'
                  : prev.direction
              : null;
            selections[s.id] = {
              odds: s.odds,
              status: s.status,
              oddsVersion: s.oddsVersion,
              direction,
              changedAt: now,
            };
          }
          return { selections };
        }
        case 'market': {
          const markets = { ...state.markets };
          for (const m of message.markets) markets[m.id] = m.status;
          return { markets };
        }
        case 'event':
          return {
            events: {
              ...state.events,
              [message.eventId]: {
                status: message.status,
                score: message.score,
                liveState: message.liveState,
                statistics: message.statistics,
                isActive: message.isActive,
              },
            },
          };
        default:
          return state;
      }
    }),
}));
