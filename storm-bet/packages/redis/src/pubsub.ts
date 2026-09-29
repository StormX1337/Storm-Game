import { REDIS_CHANNELS } from '@storm-bet/config/constants';
import type { RealtimeMessage } from '@storm-bet/types';
import type { Redis } from 'ioredis';

export async function publishRealtime(redis: Redis, messages: RealtimeMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const pipeline = redis.pipeline();
  for (const message of messages) {
    pipeline.publish(REDIS_CHANNELS.realtime, JSON.stringify(message));
  }
  await pipeline.exec();
}

export type RealtimeListener = (message: RealtimeMessage) => void;

/**
 * Fans one Redis subscription out to any number of in-process listeners
 * (one per open SSE connection).
 */
export class RealtimeHub {
  private readonly listeners = new Set<RealtimeListener>();
  private started = false;

  constructor(private readonly subscriber: Redis) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.subscriber.on('message', (_channel: string, payload: string) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(payload) as RealtimeMessage;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    await this.subscriber.subscribe(REDIS_CHANNELS.realtime);
  }

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  async stop(): Promise<void> {
    this.listeners.clear();
    await this.subscriber.quit().catch(() => undefined);
  }
}
