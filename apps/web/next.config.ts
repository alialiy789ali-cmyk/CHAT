import type { NextConfig } from 'next';

/**
 * The browser talks only to this app's origin. `/api` and `/ws` are proxied to the
 * API server by the custom server (server.ts) — both in development and production —
 * so no CORS configuration or second public port is required.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'x-frame-options', value: 'SAMEORIGIN' },
          { key: 'permissions-policy', value: 'camera=(self), microphone=(self), display-capture=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
