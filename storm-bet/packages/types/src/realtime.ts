import type { EventStatus, MarketStatus, SelectionStatus } from './enums';
import type { EventStatistics, LiveState, Pair } from './statistics';

/**
 * Messages pushed to browsers over server-sent events. They are hints to
 * refresh what is on screen, never a source of truth: the bet slip still asks
 * the server before a bet is placed.
 */
export interface OddsUpdateMessage {
  type: 'odds';
  eventId: string;
  selections: {
    id: string;
    marketId: string;
    odds: number;
    status: SelectionStatus;
    oddsVersion: number;
  }[];
}

export interface MarketUpdateMessage {
  type: 'market';
  eventId: string;
  markets: { id: string; status: MarketStatus }[];
}

export interface EventUpdateMessage {
  type: 'event';
  eventId: string;
  sportKey: string;
  status: EventStatus;
  isActive: boolean;
  score: Pair | null;
  liveState: LiveState | null;
  statistics: EventStatistics | null;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  time: string;
}

export type RealtimeMessage =
  | OddsUpdateMessage
  | MarketUpdateMessage
  | EventUpdateMessage
  | HeartbeatMessage;

/** Topics a client may subscribe to. */
export const RealtimeTopic = {
  all: 'all',
  live: 'live',
  event: (eventId: string) => `event:${eventId}`,
} as const;
