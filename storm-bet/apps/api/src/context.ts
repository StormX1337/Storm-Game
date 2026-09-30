import type { ApiEnv, BettingLimits, DemoWalletPolicy } from '@storm-bet/config';
import type {
  BetPlacementService,
  CashoutService,
  SettlementService,
} from '@storm-bet/betting-engine';
import type { CasinoService } from '@storm-bet/casino';
import type { PrismaClient } from '@storm-bet/database';
import type { JsonCache, RealtimeHub, Redis } from '@storm-bet/redis';
import type { Queue } from 'bullmq';
import type { Mailer } from './lib/mailer';

/** Everything route handlers need, created once in main.ts (or a test). */
export interface AppContext {
  env: ApiEnv;
  db: PrismaClient;
  redis: Redis;
  hub: RealtimeHub;
  cache: JsonCache;
  mailer: Mailer;
  limits: BettingLimits;
  demoWallet: DemoWalletPolicy;
  placement: BetPlacementService;
  cashout: CashoutService;
  settlement: SettlementService;
  casino: CasinoService;
  /** Read-only handles on the worker's queues, for the system health view. */
  queues: Queue[];
  now: () => Date;
}
