import { z } from 'zod';

export const uuid = z.string().uuid('Ungültige ID');

/** Money in minor units (1 = 0.01 DEMO). */
export const moneyMinor = z
  .number({ invalid_type_error: 'Betrag muss eine Zahl sein' })
  .int('Betrag muss in Cent angegeben werden')
  .nonnegative('Betrag darf nicht negativ sein')
  .max(Number.MAX_SAFE_INTEGER);

export const positiveMoneyMinor = moneyMinor.positive('Betrag muss größer als 0 sein');

/** Decimal odds as shown to the player: > 1, at most three decimals. */
export const decimalOdds = z
  .number({ invalid_type_error: 'Quote muss eine Zahl sein' })
  .gt(1, 'Quote muss größer als 1 sein')
  .max(10_000, 'Quote ist unrealistisch hoch')
  .refine(
    (v) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6,
    'Höchstens drei Nachkommastellen',
  );

export const paginationQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const isoDate = z
  .string()
  .datetime({ offset: true, message: 'Ungültiges Datum' })
  .transform((v) => new Date(v));

export const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} muss mindestens ${min} Zeichen lang sein`)
    .max(max, `${label} darf höchstens ${max} Zeichen lang sein`);

export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Ländercode im Format ISO 3166 (z. B. DE)');

/** Coerces the usual query-string spellings of a boolean. */
export const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
