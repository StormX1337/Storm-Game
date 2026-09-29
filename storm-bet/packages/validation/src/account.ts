import { LIMIT_TYPES } from '@storm-bet/types';
import { z } from 'zod';
import { moneyMinor, trimmed } from './common';
import { email } from './auth';

export const setLimitSchema = z.object({
  type: z.enum(LIMIT_TYPES),
  /** Null removes the limit (which, like any increase, waits out the cooling-off period). */
  amount: moneyMinor.nullable(),
});
export type SetLimitInput = z.infer<typeof setLimitSchema>;

export const SELF_EXCLUSION_PERIODS = ['24h', '7d', '30d', '180d', 'permanent'] as const;
export type SelfExclusionPeriod = (typeof SELF_EXCLUSION_PERIODS)[number];

export const selfExclusionSchema = z.object({
  period: z.enum(SELF_EXCLUSION_PERIODS),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Bitte bestätige die Selbstsperre' }),
  }),
  reason: z.string().trim().max(500).optional(),
});
export type SelfExclusionInput = z.infer<typeof selfExclusionSchema>;

export const contactSchema = z.object({
  name: trimmed(2, 80, 'Name'),
  email,
  subject: trimmed(3, 120, 'Betreff'),
  message: trimmed(10, 4_000, 'Nachricht'),
});
export type ContactInput = z.infer<typeof contactSchema>;
