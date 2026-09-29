import { describe, expect, it } from 'vitest';
import { milliToDecimal, moneyToNumber, oddsToMilli, Prisma } from '../src';

describe('conversions', () => {
  it('converts odds exactly', () => {
    expect(oddsToMilli(new Prisma.Decimal('1.650'))).toBe(1650);
    expect(oddsToMilli('2.97')).toBe(2970);
    expect(milliToDecimal(1833).toString()).toBe('1.833');
    expect(() => oddsToMilli('1.6505')).toThrow(RangeError);
  });

  it('refuses unsafe money values', () => {
    expect(moneyToNumber(123n)).toBe(123);
    expect(() => moneyToNumber(2n ** 60n)).toThrow(RangeError);
  });
});
