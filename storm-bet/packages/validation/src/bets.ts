import { ODDS_CHANGE_POLICIES } from '@storm-bet/types';
import { z } from 'zod';
import { decimalOdds, positiveMoneyMinor, uuid } from './common';

const MAX_SELECTIONS = 20;
const BUILDER_MAX_SELECTIONS = 8;

export const slipSelectionSchema = z.object({
  selectionId: uuid,
  /** The price the player saw. The server compares, it never trusts. */
  odds: decimalOdds,
});

const uniqueSelections = <T extends { selectionId: string }>(items: T[]) =>
  new Set(items.map((s) => s.selectionId)).size === items.length;

const oddsChangePolicy = z.enum(ODDS_CHANGE_POLICIES).default('REJECT');

export const comboSlipSchema = z.object({
  mode: z.literal('COMBO'),
  stake: positiveMoneyMinor,
  selections: z
    .array(slipSelectionSchema)
    .min(1, 'Mindestens eine Auswahl')
    .max(MAX_SELECTIONS, `Höchstens ${MAX_SELECTIONS} Auswahlen`)
    .refine(uniqueSelections, 'Jede Auswahl darf nur einmal vorkommen'),
  oddsChangePolicy,
});

export const singlesSlipSchema = z.object({
  mode: z.literal('SINGLES'),
  /** An odds boost: one selection at the boosted price. */
  boostId: uuid.optional(),
  selections: z
    .array(slipSelectionSchema.extend({ stake: positiveMoneyMinor }))
    .min(1, 'Mindestens eine Auswahl')
    .max(MAX_SELECTIONS, `Höchstens ${MAX_SELECTIONS} Auswahlen`)
    .refine(uniqueSelections, 'Jede Auswahl darf nur einmal vorkommen'),
  oddsChangePolicy,
});

const builderSelections = z
  .array(z.object({ selectionId: uuid }))
  .max(BUILDER_MAX_SELECTIONS, `Höchstens ${BUILDER_MAX_SELECTIONS} Auswahlen im Bet Builder`)
  .refine(uniqueSelections, 'Jede Auswahl darf nur einmal vorkommen');

/** Bet Builder: selections on one match, one price for all of them. */
export const builderSlipSchema = z.object({
  mode: z.literal('BUILDER'),
  stake: positiveMoneyMinor,
  selections: builderSelections.refine((s) => s.length >= 2, 'Mindestens zwei Auswahlen'),
  /** The Bet Builder price the player saw. The server prices again and compares. */
  odds: decimalOdds,
  oddsChangePolicy,
});

export const slipSchema = z.discriminatedUnion('mode', [
  comboSlipSchema,
  singlesSlipSchema,
  builderSlipSchema,
]);
export type SlipInput = z.infer<typeof slipSchema>;

export const placeBetSchema = z.intersection(slipSchema, z.object({ idempotencyKey: uuid }));
export type PlaceBetInput = z.infer<typeof placeBetSchema>;

/** Validation quotes before a stake is typed in, so stakes may be zero there. */
export const validateSlipSchema = z.discriminatedUnion('mode', [
  comboSlipSchema.extend({ stake: z.number().int().nonnegative().default(0) }),
  singlesSlipSchema.extend({
    selections: z
      .array(slipSelectionSchema.extend({ stake: z.number().int().nonnegative().default(0) }))
      .min(1)
      .max(MAX_SELECTIONS)
      .refine(uniqueSelections, 'Jede Auswahl darf nur einmal vorkommen'),
  }),
  builderSlipSchema.extend({
    stake: z.number().int().nonnegative().default(0),
    selections: builderSelections.refine((s) => s.length >= 1, 'Mindestens eine Auswahl'),
    odds: decimalOdds.optional(),
  }),
]);
export type ValidateSlipInput = z.infer<typeof validateSlipSchema>;

export const BET_LIST_FILTERS = ['all', 'open', 'won', 'lost', 'void', 'settled'] as const;
export const betListQuery = z.object({
  status: z.enum(BET_LIST_FILTERS).default('all'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BetListQuery = z.infer<typeof betListQuery>;

export const cashoutQuotesSchema = z.object({
  betIds: z.array(uuid).min(1).max(50),
});
export type CashoutQuotesInput = z.infer<typeof cashoutQuotesSchema>;

/** The cashout value the player accepted; a lower current value is refused. */
export const cashoutSchema = z.object({
  amount: positiveMoneyMinor,
  /** Partial cashout: the part of the open stake to close (less than all of it). */
  part: positiveMoneyMinor.optional(),
});

/** Auto-cashout target, or null to remove it. */
export const autoCashoutSchema = z.object({ amount: positiveMoneyMinor.nullable() });
export type AutoCashoutInput = z.infer<typeof autoCashoutSchema>;
export type CashoutInput = z.infer<typeof cashoutSchema>;
