import { describe, expect, it } from 'vitest';
import {
  DemoJurisdictionPolicy,
  DisabledPaymentGateway,
  isOfAge,
  planLimitChange,
  RealMoneyDisabledError,
  REMOVAL_MARKER,
} from '../src';

const now = new Date('2026-09-29T12:00:00Z');
const row = (amount: bigint) => ({
  type: 'STAKE_DAILY' as const,
  amount,
  effectiveFrom: now,
  pendingAmount: null,
  pendingEffectiveAt: null,
});

describe('limit changes', () => {
  it('applies a new or lower limit immediately', () => {
    expect(planLimitChange(null, 5_000n, now)).toMatchObject({
      action: 'create',
      appliesImmediately: true,
    });
    expect(planLimitChange(row(10_000n), 5_000n, now)).toMatchObject({
      action: 'update',
      amount: 5_000n,
      appliesImmediately: true,
    });
  });

  it('delays raising or removing a limit by the cooling-off period', () => {
    const raise = planLimitChange(row(10_000n), 20_000n, now);
    expect(raise).toMatchObject({
      amount: 10_000n,
      pendingAmount: 20_000n,
      appliesImmediately: false,
    });
    expect(raise.pendingEffectiveAt!.getTime() - now.getTime()).toBe(24 * 3_600_000);
    expect(planLimitChange(row(10_000n), null, now).pendingAmount).toBe(REMOVAL_MARKER);
  });

  it('lets staff apply documented changes at once', () => {
    expect(planLimitChange(row(10_000n), null, now, { byStaff: true }).action).toBe('delete');
  });
});

describe('compliance stubs', () => {
  it('never allows real money', async () => {
    expect(new DemoJurisdictionPolicy().evaluate({ country: 'DE' }).realMoneyAllowed).toBe(false);
    expect(new DemoJurisdictionPolicy(['US']).evaluate({ country: 'us' }).demoAllowed).toBe(false);
    await expect(new DisabledPaymentGateway().deposit()).rejects.toBeInstanceOf(
      RealMoneyDisabledError,
    );
  });

  it('checks age on calendar dates', () => {
    expect(isOfAge(new Date('2008-09-29'), now)).toBe(true);
    expect(isOfAge(new Date('2008-09-30'), now)).toBe(false);
  });
});
