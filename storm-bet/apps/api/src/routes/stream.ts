import type { PrismaClient } from '@storm-bet/database';
import type { RealtimeMessage } from '@storm-bet/types';
import { streamQuery } from '@storm-bet/validation';
import { AppError } from '@storm-bet/types';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { parse } from '../lib/validate';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';

const HEARTBEAT_MS = 20_000;
const MAX_PER_IP = 8;
const MAX_TOTAL = 5_000;
/** A client this far behind is dropped rather than buffered without bound. */
const MAX_BUFFER_BYTES = 1_000_000;

/** Knows which events are live, so the "live" topic can route odds messages. */
export class LiveEventTracker {
  private readonly live = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: PrismaClient) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    const rows = await this.db.event.findMany({ where: { status: 'LIVE' }, select: { id: true } });
    this.live.clear();
    for (const r of rows) this.live.add(r.id);
  }

  observe(message: RealtimeMessage): void {
    if (message.type !== 'event') return;
    if (message.status === 'LIVE' || message.status === 'SUSPENDED') this.live.add(message.eventId);
    else this.live.delete(message.eventId);
  }

  isLive(eventId: string): boolean {
    return this.live.has(eventId);
  }
}

/**
 * Server-sent events: one long-lived response per browser tab, fed from the
 * Redis realtime channel. Messages only tell the page what changed; prices
 * are always re-checked by the server when a bet is placed.
 */
export function streamRoutes(ctx: AppContext, tracker: LiveEventTracker) {
  const perIp = new Map<string, number>();
  let total = 0;
  ctx.hub.subscribe((m) => tracker.observe(m));

  return async (app: FastifyInstance) => {
    app.get('/stream', async (request, reply) => {
      const { topics } = parse(streamQuery, request.query);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.stream, request.ip);
      const open = perIp.get(request.ip) ?? 0;
      if (open >= MAX_PER_IP || total >= MAX_TOTAL) {
        throw new AppError('RATE_LIMITED', 'Zu viele offene Live-Verbindungen.', {
          retryAfter: 10,
        });
      }
      const all = topics.includes('all');
      const wantsLive = topics.includes('live');
      const events = new Set(topics.filter((t) => t.startsWith('event:')).map((t) => t.slice(6)));
      const matches = (m: RealtimeMessage): boolean => {
        if (m.type === 'heartbeat') return true;
        if (all || events.has(m.eventId)) return true;
        if (!wantsLive) return false;
        return m.type === 'event'
          ? m.status === 'LIVE' || tracker.isLive(m.eventId)
          : tracker.isLive(m.eventId);
      };

      perIp.set(request.ip, open + 1);
      total += 1;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');

      let closed = false;
      const send = (message: RealtimeMessage) => {
        if (closed) return;
        if (res.writableLength > MAX_BUFFER_BYTES) {
          cleanup();
          res.end();
          return;
        }
        res.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
      };
      const unsubscribe = ctx.hub.subscribe((m) => {
        if (matches(m)) send(m);
      });
      const heartbeat = setInterval(
        () => send({ type: 'heartbeat', time: new Date().toISOString() }),
        HEARTBEAT_MS,
      );
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        total -= 1;
        const n = (perIp.get(request.ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(request.ip);
        else perIp.set(request.ip, n);
      };
      request.raw.on('close', cleanup);
      res.on('error', cleanup);
    });
  };
}
