import type { KycStatus } from '@storm-bet/types';

/**
 * Integration point for identity and age verification. Required before any
 * real-money feature can exist; irrelevant for play money, which is why the
 * only implementation shipped reports "not required" and refuses to start a
 * verification.
 */
export interface KycProvider {
  readonly name: string;
  status(userId: string): Promise<KycStatus>;
  startVerification(userId: string): Promise<{ redirectUrl: string }>;
}

export class KycNotConfiguredError extends Error {
  constructor() {
    super('No KYC provider is configured; identity verification is unavailable in demo mode.');
    this.name = 'KycNotConfiguredError';
  }
}

export class DemoKycProvider implements KycProvider {
  readonly name = 'none (demo)';

  async status(): Promise<KycStatus> {
    return 'NOT_REQUIRED';
  }

  async startVerification(): Promise<{ redirectUrl: string }> {
    throw new KycNotConfiguredError();
  }
}

export const MINIMUM_AGE = 18;

/** Age check for a future real-money gate; computed on calendar dates, not 365-day years. */
export function isOfAge(dateOfBirth: Date, now: Date, minimumAge = MINIMUM_AGE): boolean {
  const threshold = new Date(
    Date.UTC(now.getUTCFullYear() - minimumAge, now.getUTCMonth(), now.getUTCDate()),
  );
  return dateOfBirth.getTime() <= threshold.getTime();
}
