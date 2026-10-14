import { createServer } from 'node:http';
import process from 'node:process';
import next from 'next';
import httpProxy from 'http-proxy';

/**
 * Custom Next.js server.
 *
 * Why not `next dev` alone: the browser must reach the API and the realtime gateway
 * on the *same origin*. Proxying `/api` (HTTP) and `/ws` (WebSocket upgrade) here means
 *  - no CORS surface in the browser,
 *  - one public port to expose/reverse-proxy (with TLS terminated in front),
 *  - cookies for the refresh token stay first-party.
 *
 * `API_URL` points at the API server (default http://localhost:8787).
 */

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME_BIND ?? '0.0.0.0';
const apiUrl = process.env.API_URL ?? 'http://localhost:8787';
const dev = process.env.NODE_ENV !== 'production';

const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({
  target: apiUrl,
  changeOrigin: true,
  ws: true,
  // Long-lived WebSocket connections must not be cut by a proxy timeout.
  proxyTimeout: 0,
  timeout: 0,
  xfwd: true,
});

proxy.on('error', (err, _req, res) => {
  const target = res as unknown as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (body?: string) => void };
  if (typeof target?.writeHead === 'function') {
    target.writeHead(503, { 'content-type': 'application/json' });
    target.end?.(JSON.stringify({ error: { code: 'service_unavailable', message: 'api_unreachable' } }));
  }
  console.error('[proxy] error:', (err as Error).message);
});

await app.prepare();

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api') || url.startsWith('/health')) {
    proxy.web(req, res);
    return;
  }
  void handle(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url.startsWith('/ws')) {
    proxy.ws(req, socket as never, head as never);
    return;
  }
  socket.destroy();
});

server.listen(port, hostname, () => {
  console.log(`[web] Sovereign web listening on http://${hostname}:${port} (api: ${apiUrl})`);
});

const shutdown = (signal: string) => {
  console.log(`[web] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
