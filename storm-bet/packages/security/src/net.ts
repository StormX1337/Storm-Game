import { isIP } from 'node:net';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function expandIpv6(ip: string): bigint {
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [
    ...headParts,
    ...Array<string>(ip.includes('::') ? missing : 0).fill('0'),
    ...tailParts,
  ];
  return parts.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
}

/** Normalises IPv4-mapped IPv6 ("::ffff:10.0.0.1") to plain IPv4. */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped?.[1] ?? ip;
}

/** True when `ip` lies inside `cidr` (IPv4 or IPv6; a bare address is a /32 or /128). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const address = normalizeIp(ip.trim());
  const [range = '', bitsText] = cidr.trim().split('/');
  const family = isIP(address);
  if (family === 0 || family !== isIP(range)) return false;
  if (family === 4) {
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(address) & mask) === (ipv4ToInt(range) & mask);
  }
  const bits = bitsText === undefined ? 128 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const shift = BigInt(128 - bits);
  return expandIpv6(address) >> shift === expandIpv6(range) >> shift;
}

export function ipAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((cidr) => ipInCidr(ip, cidr));
}
