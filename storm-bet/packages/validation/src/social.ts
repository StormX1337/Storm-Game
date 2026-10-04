import { z } from 'zod';
import { uuid } from './common';

/** Picks kept for later; loaded again at the then current odds. */
export const savedSlipSchema = z.object({
  name: z.string().trim().min(1).max(40),
  selectionIds: z
    .array(uuid)
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Jeder Tipp nur einmal.'),
});
export type SavedSlipInput = z.infer<typeof savedSlipSchema>;

export const LEADERBOARD_PERIODS = ['week', 'month'] as const;
export const LEADERBOARD_RANKINGS = ['profit', 'hitrate'] as const;
export const leaderboardQuery = z.object({
  period: z.enum(LEADERBOARD_PERIODS).default('week'),
  by: z.enum(LEADERBOARD_RANKINGS).default('profit'),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuery>;

export const leaderboardOptInSchema = z.object({ optIn: z.boolean() });
