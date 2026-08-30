import { lookup } from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_V4 = [
  { base: '0.0.0.0', bits: 8 },
  { base: '10.0.0.0', bits: 8 },
  { base: '100.64.0.0', bits: 10 },
  { base: '127.0.0.0', bits: 8 },
  { base: '169.254.0.0', bits: 16 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.0.0.0', bits: 24 },
  { base: '192.168.0.0', bits: 16 },
  { base: '198.18.0.0', bits: 15 },
  { base: '224.0.0.0', bits: 4 },
  { base: '240.0.0.0', bits: 4 },
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    if (value < 0) return true;
    return BLOCKED_V4.some(({ base, bits }) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
    // IPv4-mapped addresses inherit the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export interface SsrfCheckOptions {
  /** Allow private targets — used for operator-configured internal endpoints. */
  allowPrivate?: boolean;
  allowedProtocols?: string[];
}

/**
 * Validates a user-supplied URL (webhooks, remote file pulls) before we make an
 * outbound request with it. Resolves DNS so a public hostname pointing at
 * 169.254.169.254 is still rejected.
 */
export async function assertSafeUrl(rawUrl: string, options: SsrfCheckOptions = {}): Promise<URL> {
  const allowedProtocols = options.allowedProtocols ?? ['https:', 'http:'];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`Protocol ${url.protocol} is not allowed`);
  }
  if (options.allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Destination address is not routable');
    return url;
  }

  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error('Host could not be resolved');
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error('Destination resolves to a private address');
    }
  }
  return url;
}
