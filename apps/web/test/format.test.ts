import { describe, expect, it } from 'vitest';
import { ServerStatus } from '@storm/types';
import {
  LOCALE,
  SERVER_STATUS_META,
  formatBytes,
  formatDate,
  formatDateShort,
  formatMib,
  formatNumber,
  formatRelative,
  formatUptime,
  humaniseEvent,
  initials,
  usagePercent,
} from '@/lib/format';

describe('formatBytes', () => {
  it('scales to the right unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MiB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GiB');
  });

  it('shows whole bytes without a decimal', () => {
    // "1.0 B" reads like a rounding artefact; bytes are counted, not measured.
    expect(formatBytes(7)).toBe('7 B');
  });

  it('survives the values an agent actually sends when a server is down', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('does not run off the end of the unit list', () => {
    expect(formatBytes(1024 ** 8)).toMatch(/PiB$/);
  });
});

describe('formatMib', () => {
  it('reads API limits as MiB', () => {
    // A 2048 MiB memory limit has to read as 2 GiB, not 2 KiB.
    expect(formatMib(2048)).toBe('2.0 GiB');
    expect(formatMib(512)).toBe('512.0 MiB');
  });
});

describe('formatUptime', () => {
  it('drops to the two units that matter at each scale', () => {
    expect(formatUptime(45_000)).toBe('45s');
    expect(formatUptime(3 * 60_000 + 5_000)).toBe('3m 5s');
    expect(formatUptime(5 * 3_600_000 + 7 * 60_000)).toBe('5h 7m');
    expect(formatUptime(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
  });

  it('shows a dash rather than 0s for a server that is not running', () => {
    expect(formatUptime(0)).toBe('—');
    expect(formatUptime(Number.NaN)).toBe('—');
  });
});

describe('SERVER_STATUS_META', () => {
  it('covers every status the API can report', () => {
    // A status without an entry renders as a raw enum name to a customer.
    for (const status of Object.values(ServerStatus)) {
      expect(SERVER_STATUS_META[status], `missing meta for ${status}`).toBeDefined();
      expect(SERVER_STATUS_META[status].label).not.toMatch(/_/);
    }
  });

  it('marks the transient states as pulsing and the settled ones as still', () => {
    expect(SERVER_STATUS_META.STARTING.pulse).toBe(true);
    expect(SERVER_STATUS_META.INSTALLING.pulse).toBe(true);
    expect(SERVER_STATUS_META.ONLINE.pulse).toBeUndefined();
    expect(SERVER_STATUS_META.OFFLINE.pulse).toBeUndefined();
  });

  it('uses the alarming tone only where something is actually wrong', () => {
    expect(SERVER_STATUS_META.CRASHED.tone).toBe('destructive');
    expect(SERVER_STATUS_META.INSTALL_FAILED.tone).toBe('destructive');
    expect(SERVER_STATUS_META.ONLINE.tone).toBe('success');
    expect(SERVER_STATUS_META.OFFLINE.tone).toBe('muted');
  });
});

describe('usagePercent', () => {
  it('treats a zero limit as unlimited rather than dividing by it', () => {
    expect(usagePercent(500, 0)).toBe(0);
  });

  it('clamps, so an overcommitted server cannot draw past its bar', () => {
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(-5, 100)).toBe(0);
    expect(usagePercent(25, 100)).toBe(25);
  });
});

describe('humaniseEvent', () => {
  it('turns audit keys into prose', () => {
    expect(humaniseEvent('auth.login')).toBe('Login');
    expect(humaniseEvent('server:power.start')).toBe('Power start');
    expect(humaniseEvent('admin.user_created')).toBe('User created');
  });
});

describe('initials', () => {
  it('builds an avatar label from whatever the account has', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('ada')).toBe('AD');
    expect(initials('ada.lovelace@example.com')).toBe('AL');
  });

  it('does not crash on an empty name', () => {
    expect(initials('   ')).toBe('??');
  });
});

describe('language of dates and numbers', () => {
  // These ran through the browser's locale, so a German phone rendered "vor 12
  // Minuten" and "31.08.2026" inside an otherwise English panel. Half-English
  // is worse than either language, and it is not something you notice unless
  // you are testing on a device that is not set to English.
  it("is English regardless of what the reader's device is set to", () => {
    expect(LOCALE).toBe('en-GB');
  });

  it('says "ago" rather than "vor"', () => {
    const twelveMinutesAgo = new Date(Date.now() - 12 * 60_000);
    expect(formatRelative(twelveMinutesAgo)).toBe('12 minutes ago');

    const inTwoHours = new Date(Date.now() + 2 * 3600_000);
    expect(formatRelative(inTwoHours)).toBe('in 2 hours');
  });

  it('writes months as words, not as a number that reads differently elsewhere', () => {
    // 08/09 is September in Berlin and August in Boston; "9 Aug" is neither.
    const date = new Date('2026-08-09T12:00:00Z');
    expect(formatDateShort(date)).toMatch(/Aug/);
    expect(formatDateShort(date)).not.toMatch(/^\d+\.\d+\./);
  });

  it('keeps a 24-hour clock, because AM/PM has no place in a log', () => {
    const evening = new Date('2026-08-09T18:30:00Z');
    expect(formatDate(evening)).not.toMatch(/[AP]M/i);
  });

  it('groups numbers the English way', () => {
    // 1.234.567 in German, and the panel shows these next to English labels.
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('still answers when there is nothing to format', () => {
    expect(formatRelative(null)).toBe('never');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });
});
