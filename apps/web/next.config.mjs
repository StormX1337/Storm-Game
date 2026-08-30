/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The UI package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@storm/ui', '@storm/types'],
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // In development the API runs on its own port. In production nginx serves
    // both from one origin, so this rewrite is a no-op there.
    //
    // Next resolves this at build time and writes it into routes-manifest.json:
    // API_INTERNAL_URL has to be set when building, not when starting.
    const target = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8080';
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/health', destination: `${target}/health` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
