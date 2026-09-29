import path from 'node:path';
import type { NextConfig } from 'next';

const isHttps = (process.env.APP_URL ?? '').startsWith('https://');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  ...(isHttps
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const config: NextConfig = {
  output: 'standalone',
  // The monorepo root, so the standalone build traces workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    '@storm-bet/ui',
    '@storm-bet/types',
    '@storm-bet/validation',
    '@storm-bet/config',
  ],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
