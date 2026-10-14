/**
 * The server address a phone talks to.
 *
 * This is the part of the mobile client that decides whether the app can reach *your* server at all,
 * so it is tested against a real HTTP listener rather than an assumed one: `probeServer` must tell
 * "this is my server" apart from "something answered" apart from "nothing answered", because the
 * user's next action differs in each case.
 *
 * The OS keychain is the only stand-in (`expo-secure-store` is a native module): the in-memory store
 * below implements the same three calls, so the persistence logic is exercised for real.
 *
 * Note the deliberate absence of a "scheme is optional" surprise: the app accepts what a human types
 * (`192.168.1.20:8787`) and normalises it, and refuses anything that is not http/https instead of
 * building a URL the fetch API cannot use.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    keychain.delete(key);
  },
}));

const {
  DEFAULT_API_URL,
  clearServerUrl,
  currentApiUrl,
  loadSavedServerUrl,
  normaliseServerUrl,
  probeServer,
  saveServerUrl,
  usingOverride,
} = await import('../src/lib/server-address');

let server: Server;
let origin = '';
/** What the fake server answers on `/api/health`; the tests rewrite it per case. */
let healthBody: string = JSON.stringify({ app: 'Sovereign', version: '0.1.0', status: 'ok' });
let healthStatus = 200;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith('/api/health')) {
      response.writeHead(healthStatus, { 'content-type': 'application/json' });
      response.end(healthBody);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<html><body>some other web server</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address) origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  keychain.clear();
  healthBody = JSON.stringify({ app: 'Sovereign', version: '0.1.0', status: 'ok' });
  healthStatus = 200;
  await clearServerUrl();
});

describe('normaliseServerUrl', () => {
  it('accepts a bare host and port, which is what a human types', () => {
    expect(normaliseServerUrl('192.168.1.20:8787')).toEqual({ ok: true, url: 'http://192.168.1.20:8787' });
  });

  it('keeps https and drops a trailing slash', () => {
    expect(normaliseServerUrl('https://chat.example.com/')).toEqual({ ok: true, url: 'https://chat.example.com' });
  });

  it('keeps a reverse-proxy subpath but removes its trailing slash', () => {
    expect(normaliseServerUrl('https://example.com/sovereign/')).toEqual({
      ok: true,
      url: 'https://example.com/sovereign',
    });
  });

  it('trims surrounding whitespace (a paste from a message often carries it)', () => {
    expect(normaliseServerUrl('  http://10.0.0.5:8787  ')).toEqual({ ok: true, url: 'http://10.0.0.5:8787' });
  });

  it('refuses empty input and non-http schemes', () => {
    expect(normaliseServerUrl('   ').ok).toBe(false);
    expect(normaliseServerUrl('ftp://example.com').ok).toBe(false);
    expect(normaliseServerUrl('ws://example.com').ok).toBe(false);
  });
});

describe('saved override', () => {
  it('starts at the build default', async () => {
    expect(await loadSavedServerUrl()).toBe(DEFAULT_API_URL);
    expect(currentApiUrl()).toBe(DEFAULT_API_URL);
    expect(usingOverride()).toBe(false);
  });

  it('stores a valid address and applies it immediately', async () => {
    const result = await saveServerUrl('192.168.1.20:8787');
    expect(result).toEqual({ ok: true, url: 'http://192.168.1.20:8787' });
    expect(currentApiUrl()).toBe('http://192.168.1.20:8787');
    expect(usingOverride()).toBe(true);
    // A fresh read (app restart) restores the same address.
    keychain.set('sovereign.serverUrl', 'http://192.168.1.20:8787');
    expect(await loadSavedServerUrl()).toBe('http://192.168.1.20:8787');
  });

  it('does not save an invalid address', async () => {
    const result = await saveServerUrl('ftp://example.com');
    expect(result.ok).toBe(false);
    expect(keychain.has('sovereign.serverUrl')).toBe(false);
    expect(currentApiUrl()).toBe(DEFAULT_API_URL);
  });

  it('falls back to the default when the stored value is unreadable', async () => {
    keychain.set('sovereign.serverUrl', 'not a url at all');
    expect(await loadSavedServerUrl()).toBe(DEFAULT_API_URL);
    expect(usingOverride()).toBe(false);
  });

  it('forgets the override on request', async () => {
    await saveServerUrl('http://192.168.1.20:8787');
    expect(await clearServerUrl()).toBe(DEFAULT_API_URL);
    expect(keychain.has('sovereign.serverUrl')).toBe(false);
  });
});

describe('probeServer', () => {
  it('recognises this API and reports what it calls itself', async () => {
    const probe = await probeServer(origin);
    expect(probe.reachable).toBe(true);
    expect(probe.appName).toBe('Sovereign');
    expect(probe.version).toBe('0.1.0');
  });

  it('distinguishes "something answered" from "my server answered"', async () => {
    healthBody = '<html>router admin page</html>';
    healthStatus = 200;
    const probe = await probeServer(origin);
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain('ليس هذه الواجهة');
  });

  it('reports a non-200 answer as a status problem, not as a network problem', async () => {
    healthStatus = 502;
    const probe = await probeServer(origin);
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain('502');
  });

  it('reports an unreachable address without hanging', async () => {
    // Port 1 is never a web server; the timeout is short so the test stays fast.
    const probe = await probeServer('http://127.0.0.1:1', 1500);
    expect(probe.reachable).toBe(false);
    expect(probe.detail.length).toBeGreaterThan(0);
  });

  it('gives up on a silent server instead of waiting forever', async () => {
    const silent = createServer(() => {
      // Accepts the connection and never answers — the case that would hang a naive client.
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const started = Date.now();
    const probe = await probeServer(`http://127.0.0.1:${port}`, 500);
    const elapsed = Date.now() - started;
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain('المهلة');
    expect(elapsed).toBeLessThan(3000);
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });
});
