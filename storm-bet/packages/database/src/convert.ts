import { Prisma } from '@prisma/client';

/**
 * Money crosses the API as a JS number of minor units. Every amount this
 * product can produce fits in 2^53 by several orders of magnitude; the check
 * turns a corrupt value into a loud failure instead of a silent rounding.
 */
export function moneyToNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Amount out of range: ${value}`);
  return n;
}

export function toBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer amount: ${value}`);
  return BigInt(value);
}

/** Decimal odds (NUMERIC(8,3)) → integer thousandths, exactly. */
export function oddsToMilli(value: Prisma.Decimal | string | number): number {
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  const milli = decimal.mul(1000);
  if (!milli.isInteger()) throw new RangeError(`Odds with more than 3 decimals: ${decimal}`);
  return milli.toNumber();
}

export function milliToDecimal(milli: number): Prisma.Decimal {
  return new Prisma.Decimal(milli).div(1000);
}

export function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value == null ? null : value.toNumber();
}
