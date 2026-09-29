'use client';

import type { EventSummaryDto, MarketStatus, SelectionDto } from '@storm-bet/types';
import { useLive } from '@/stores/live';

/** Server value, or the pushed value when it is newer. */
export function useLiveSelection(selection: SelectionDto) {
  const live = useLive((s) => s.selections[selection.id]);
  if (live && live.oddsVersion > selection.oddsVersion) {
    return {
      odds: live.odds,
      status: live.status,
      direction: live.direction,
      changedAt: live.changedAt,
      version: live.oddsVersion,
    };
  }
  return {
    odds: selection.odds,
    status: selection.status,
    direction: null,
    changedAt: 0,
    version: selection.oddsVersion,
  };
}

export function useLiveMarketStatus(marketId: string, fallback: MarketStatus): MarketStatus {
  return useLive((s) => s.markets[marketId]) ?? fallback;
}

export function useLiveEvent(
  event: Pick<EventSummaryDto, 'id' | 'status' | 'score' | 'liveState' | 'isLive'>,
) {
  const live = useLive((s) => s.events[event.id]);
  if (!live)
    return {
      status: event.status,
      score: event.score,
      liveState: event.liveState,
      isLive: event.isLive,
      statistics: null,
    };
  return {
    status: live.status,
    score: live.score ?? event.score,
    liveState: live.liveState ?? event.liveState,
    isLive: live.status === 'LIVE',
    statistics: live.statistics,
  };
}
