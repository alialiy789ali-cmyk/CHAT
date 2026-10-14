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
  /**
   * Matrix Olm ships as an Emscripten UMD bundle that also contains a Node code path, so it
   * references `fs`, `path` and `crypto`. Those branches never run in a browser — the module is
   * initialised with `locateFile` pointing at `/olm.wasm` — but webpack still has to resolve the
   * imports, so they are stubbed out for client bundles.
   */
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, path: false, crypto: false };
    }
    return config;
  },
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
