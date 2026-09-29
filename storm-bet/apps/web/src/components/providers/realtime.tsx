'use client';

import type { RealtimeMessage } from '@storm-bet/types';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBetSlip } from '@/stores/bet-slip';
import { useLive } from '@/stores/live';

interface RealtimeContextValue {
  register: (topics: string[]) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);
const MAX_TOPICS = 50;

/**
 * One EventSource per tab. Components declare the topics they need; the
 * provider subscribes to their union and reconnects (debounced) when it
 * changes. Every message updates the live store and, for selections on the
 * slip, records the new price as a change the player must accept.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const counts = useRef(new Map<string, number>());
  const [topicKey, setTopicKey] = useState('');
  const timer = useRef<number | null>(null);

  const recompute = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const topics = [...counts.current.keys()].sort();
      // Keep "live" first; event topics beyond the cap fall back to it.
      const capped = topics.includes('live')
        ? ['live', ...topics.filter((t) => t !== 'live')]
        : topics;
      setTopicKey(capped.slice(0, MAX_TOPICS).join(','));
    }, 150);
  };

  const value = useMemo<RealtimeContextValue>(
    () => ({
      register: (topics) => {
        for (const t of topics) counts.current.set(t, (counts.current.get(t) ?? 0) + 1);
        recompute();
        return () => {
          for (const t of topics) {
            const n = (counts.current.get(t) ?? 1) - 1;
            if (n <= 0) counts.current.delete(t);
            else counts.current.set(t, n);
          }
          recompute();
        };
      },
    }),
    [],
  );

  useEffect(() => {
    if (!topicKey) return;
    const apply = useLive.getState().apply;
    const setConnected = useLive.getState().setConnected;
    const source = new EventSource(`/api/stream?topics=${encodeURIComponent(topicKey)}`);
    const onMessage = (event: MessageEvent<string>) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(event.data) as RealtimeMessage;
      } catch {
        return;
      }
      apply(message);
      if (message.type === 'odds') {
        const slip = useBetSlip.getState();
        for (const s of message.selections) {
          if (slip.items.some((i) => i.selectionId === s.id)) slip.observe(s.id, s.odds, s.status);
        }
      }
    };
    for (const type of ['odds', 'market', 'event', 'heartbeat'])
      source.addEventListener(type, onMessage);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      setConnected(false);
    };
  }, [topicKey]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/** Subscribes the calling component to realtime topics for as long as it is mounted. */
export function useRealtimeTopics(topics: string[]) {
  const ctx = useContext(RealtimeContext);
  const key = topics.join(',');
  useEffect(() => {
    if (!ctx || !key) return;
    return ctx.register(key.split(','));
  }, [ctx, key]);
}
