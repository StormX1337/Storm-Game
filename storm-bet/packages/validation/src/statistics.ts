import type {
  BasketballStatistics,
  EventStatistics,
  FootballStatistics,
  LiveState,
  TennisStatistics,
} from '@storm-bet/types';
import { z } from 'zod';

const count = z.number().int().min(0).max(1_000);
const pair = z.object({ home: count, away: count });
const side = z.enum(['HOME', 'AWAY']);
const stat = z.number().int().min(0).max(1_000);
const playerLines = z
  .array(
    z.object({
      playerId: z.string().min(1).max(100),
      name: z.string().max(80).nullable(),
      stats: z
        .object({
          goals: stat.optional(),
          points: stat.optional(),
          rebounds: stat.optional(),
          assists: stat.optional(),
        })
        .strict(),
    }),
  )
  .max(80);

export const footballStatisticsSchema = z.object({
  sport: z.literal('football'),
  goals: pair,
  corners: pair.optional(),
  yellowCards: pair.optional(),
  redCards: pair.optional(),
  shotsOnTarget: pair.optional(),
  possession: pair.optional(),
  goalEvents: z
    .array(
      z.object({
        minute: z.number().int().min(0).max(130),
        side,
        playerId: z.string().uuid().nullable(),
        playerName: z.string().max(80).nullable(),
      }),
    )
    .max(60)
    .optional(),
  firstHalf: pair.optional(),
  secondHalf: pair.optional(),
  players: playerLines.optional(),
});

export const tennisStatisticsSchema = z.object({
  sport: z.literal('tennis'),
  sets: z.array(pair).max(5),
  setsWon: pair,
  currentGame: z.object({ home: z.string().max(3), away: z.string().max(3) }).nullable(),
  server: side.nullable(),
  aces: pair.optional(),
});

export const basketballStatisticsSchema = z.object({
  sport: z.literal('basketball'),
  points: pair,
  periods: z.array(pair).max(10),
  fouls: pair.optional(),
  firstHalf: pair.optional(),
  players: playerLines.optional(),
});

export const eventStatisticsSchema = z.discriminatedUnion('sport', [
  footballStatisticsSchema,
  tennisStatisticsSchema,
  basketballStatisticsSchema,
]);

export const liveStateSchema = z.object({
  period: z.string().max(8),
  clock: z.string().max(12).nullable(),
});

// Compile-time proof that the schemas describe exactly the shared types.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _football: Equals<z.infer<typeof footballStatisticsSchema>, FootballStatistics> = true;
const _tennis: Equals<z.infer<typeof tennisStatisticsSchema>, TennisStatistics> = true;
const _basketball: Equals<z.infer<typeof basketballStatisticsSchema>, BasketballStatistics> = true;
const _live: Equals<z.infer<typeof liveStateSchema>, LiveState> = true;
void [_football, _tennis, _basketball, _live];

/** Parses statistics read back from a JSON column; corrupt data yields null, never a crash. */
export function parseStatistics(value: unknown): EventStatistics | null {
  const result = eventStatisticsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLiveState(value: unknown): LiveState | null {
  const result = liveStateSchema.safeParse(value);
  return result.success ? result.data : null;
}
