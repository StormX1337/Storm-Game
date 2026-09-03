import { RESOURCE_CEILING_RATIO, type NodeStatus, type ServerStatus } from '@storm/types';

/**
 * The panel is written in English, so its dates are too. Passing `undefined`
 * here follows the browser instead, which puts "vor 12 Minuten" next to
 * "Update available" on a German phone — half-translated is worse than either
 * language. en-GB for the 24-hour clock: AM/PM has no place in a log.
 *
 * Only the language is pinned. Times still render in the reader's own zone,
 * which is what makes "last seen" mean anything to them.
 */
export const LOCALE = 'en-GB';

/* ------------------------------------------------------------------ sizes -- */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/**
 * A byte figure, with enough precision to tell two of them apart and no more.
 *
 * A fixed one decimal writes "259.5 MiB" next to a limit of "10 GiB" on the
 * same card. A fixed zero makes a chart axis read "1 GiB, 1 GiB" for two
 * different ticks, which is worse: it looks like the chart is broken.
 *
 * So the precision follows the mantissa. Under ten it earns a decimal, at ten
 * or over it does not, raw bytes never get one, and a decimal that turned out
 * to be zero is dropped — a limit of exactly two gibibytes is "2 GiB", not
 * "2.0 GiB", and printing it both ways on one card is how this started.
 *
 * Pass `decimals` to override where a caller genuinely needs a fixed shape.
 */
export function formatBytes(bytes: number, decimals?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const places = exponent === 0 ? 0 : (decimals ?? (value >= 10 ? 0 : 1));
  const text = value.toFixed(places).replace(/\.0+$/, '');
  return `${text} ${BYTE_UNITS[exponent]}`;
}

/**
 * Values the API reports in MiB (limits, node capacity).
 *
 * `decimals` is passed straight through rather than defaulted, so a limit is
 * written the same way here as the figure it is a limit on.
 */
export function formatMib(mib: number, decimals?: number): string {
  return formatBytes(mib * 1024 * 1024, decimals);
}

export function formatBitrate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(decimals)}%`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/* ------------------------------------------------------------------ times -- */

export function formatUptime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDateShort(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(date);
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'never';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

  if (absolute < 45) return formatter.format(Math.round(seconds), 'second');
  if (absolute < 2700) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 79200) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 2592000) return formatter.format(Math.round(seconds / 86400), 'day');
  if (absolute < 31536000) return formatter.format(Math.round(seconds / 2592000), 'month');
  return formatter.format(Math.round(seconds / 31536000), 'year');
}

/* --------------------------------------------------------------- statuses -- */

export type StatusTone = 'success' | 'warning' | 'destructive' | 'muted' | 'default';

export const SERVER_STATUS_META: Record<
  ServerStatus,
  { label: string; tone: StatusTone; pulse?: boolean }
> = {
  INSTALLING: { label: 'Installing', tone: 'default', pulse: true },
  INSTALL_FAILED: { label: 'Install failed', tone: 'destructive' },
  STARTING: { label: 'Starting', tone: 'warning', pulse: true },
  ONLINE: { label: 'Online', tone: 'success' },
  STOPPING: { label: 'Stopping', tone: 'warning', pulse: true },
  OFFLINE: { label: 'Offline', tone: 'muted' },
  CRASHED: { label: 'Crashed', tone: 'destructive' },
  SUSPENDED: { label: 'Suspended', tone: 'destructive' },
  REINSTALLING: { label: 'Reinstalling', tone: 'default', pulse: true },
  TRANSFERRING: { label: 'Moving node', tone: 'default', pulse: true },
};

export const NODE_STATUS_META: Record<
  NodeStatus,
  { label: string; tone: StatusTone; pulse?: boolean }
> = {
  ONLINE: { label: 'Online', tone: 'success' },
  OFFLINE: { label: 'Offline', tone: 'destructive' },
  DEGRADED: { label: 'Degraded', tone: 'warning', pulse: true },
  MAINTENANCE: { label: 'Maintenance', tone: 'muted' },
};

/** Turns `server:power.start` or `admin.user_created` into readable prose. */
export function humaniseEvent(event: string): string {
  const cleaned = event.replace(
    /^(server|admin|auth|account|file|backup|schedule|database):?\.?/,
    '',
  );
  const words = cleaned.replace(/[._:]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s.@_-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/** Percentage of a limit, clamped for display. Zero limit means unlimited. */
export function usagePercent(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

/**
 * The share of a limit at which the panel starts calling it a problem.
 *
 * Re-exported from the shared package rather than written again here, so the
 * amber card and the notification the API sends cannot drift apart.
 */
export const CEILING_RATIO = RESOURCE_CEILING_RATIO;

/** Whether a reading is close enough to its limit to be worth a colour. */
export function atCeiling(usedBytes: number, limitMib: number): boolean {
  if (limitMib <= 0) return false;
  return usedBytes >= limitMib * 1024 * 1024 * CEILING_RATIO;
}

/**
 * What a stat card says the limit is, including when there is not one.
 *
 * Zero means unlimited everywhere in the panel, and `formatMib(0)` is "0 B" —
 * so an unmetered server read "of 0 B" while happily using sixteen gibibytes.
 */
export function limitHint(limitMib: number, prefix = 'of'): string {
  return limitMib > 0 ? `${prefix} ${formatMib(limitMib)}` : 'Unlimited';
}
