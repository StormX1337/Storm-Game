/**
 * Display formatting. Amounts arrive as integer minor units of DEMO; nothing
 * here does arithmetic that matters — the server's figures are authoritative.
 */
const TZ = 'Europe/Berlin';

const moneyFormat = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(
  minor: number,
  options: { sign?: boolean; unit?: boolean } = {},
): string {
  const { sign = false, unit = true } = options;
  const value = moneyFormat.format(Math.abs(minor) / 100);
  const prefix = minor < 0 ? '−' : sign && minor > 0 ? '+' : '';
  return `${prefix}${value}${unit ? '\u00a0€' : ''}`;
}

/** Decimal odds: two decimals, three when the third is significant. */
export function formatOdds(odds: number): string {
  const milli = Math.round(odds * 1000);
  return milli % 10 === 0 ? (milli / 1000).toFixed(2) : (milli / 1000).toFixed(3);
}

/** "12,50" / "12.5" / "12" → 1250 minor units; null when not a valid amount. */
export function parseStake(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const minor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function stakeInput(minor: number): string {
  return (minor / 100).toFixed(2).replace('.', ',');
}

const time = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ,
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});
const full = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatKickoff(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const today = dayKey.format(now);
  const tomorrow = dayKey.format(new Date(now.getTime() + 86_400_000));
  const key = dayKey.format(date);
  if (key === today) return `Heute ${time.format(date)}`;
  if (key === tomorrow) return `Morgen ${time.format(date)}`;
  return `${dayMonth.format(date)} ${time.format(date)}`;
}

export function formatDateTime(iso: string): string {
  return full.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}
