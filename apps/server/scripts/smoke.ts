/**
 * End-to-end smoke test against a *running* server (default http://localhost:8787).
 *
 * It performs the same critical path a human would: register two accounts, exchange a
 * message over the real WebSocket, fetch history, post publicly, and read the feed.
 * Exits non-zero on the first failure so it can gate a deployment.
 *
 * Usage: `npm run smoke` (API_URL=http://host:port to target another environment).
 */
import WebSocket from 'ws';

const API = process.env.API_URL ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws');

const stamp = Date.now().toString(36);
const password = 'Sovereign-Smoke-2026';

interface Step {
  name: string;
  run: () => Promise<void>;
}

async function json<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return body as T;
}

const steps: Step[] = [];
const add = (name: string, run: () => Promise<void>) => steps.push({ name, run });

let aliceToken = '';
let bobToken = '';
let bobId = '';
let conversationId = '';
let postId = '';

add('health endpoint reports ok', async () => {
  const health = await json<{ status: string; checks: Record<string, { ok: boolean }> }>('/api/health');
  if (health.status !== 'ok') throw new Error(`health not ok: ${JSON.stringify(health.checks)}`);
});

add('user A registers', async () => {
  const res = await json<{ accessToken: string; user: { id: string } }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: `smoke_a_${stamp}`.slice(0, 24),
      email: `smoke.a.${stamp}@example.test`,
      password,
      displayName: 'Smoke A',
    }),
  });
  aliceToken = res.accessToken;
});

add('user B registers', async () => {
  const res = await json<{ accessToken: string; user: { id: string } }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: `smoke_b_${stamp}`.slice(0, 24),
      email: `smoke.b.${stamp}@example.test`,
      password,
      displayName: 'Smoke B',
    }),
  });
  bobToken = res.accessToken;
  bobId = res.user.id;
});

add('A opens a direct conversation with B', async () => {
  const res = await json<{ conversation: { id: string } }>('/api/conversations/direct', {
    method: 'POST',
    token: aliceToken,
    body: JSON.stringify({ userId: bobId }),
  });
  conversationId = res.conversation.id;
});

add('B receives a live message over WebSocket', async () => {
  const { ticket } = await json<{ ticket: string }>('/api/auth/realtime-ticket', {
    method: 'POST',
    token: bobToken,
    body: '{}',
  });
  const socket = new WebSocket(`${WS_URL}/ws?ticket=${encodeURIComponent(ticket)}`);
  const received = new Promise<{ body: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the live message (10s)')), 10_000);
    socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as { t: string; message?: { body?: string } };
      if (frame.t === 'message' && frame.message?.body) {
        clearTimeout(timer);
        resolve({ body: frame.message.body });
      }
    });
    socket.on('error', (err) => reject(err));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await json('/api/conversations/' + conversationId + '/messages', {
    method: 'POST',
    token: aliceToken,
    body: JSON.stringify({ clientMessageId: `smoke-${stamp}`, body: 'رسالة فحص فوري' }),
  });
  const delivered = await received;
  if (delivered.body !== 'رسالة فحص فوري') throw new Error(`unexpected payload: ${JSON.stringify(delivered)}`);
  socket.close();
});

add('history is persisted and readable by A', async () => {
  const res = await json<{ items: Array<{ body: string }> }>(
    `/api/conversations/${conversationId}/messages?limit=10`,
    { token: aliceToken },
  );
  if (!res.items.some((m) => m.body === 'رسالة فحص فوري')) throw new Error('message missing from history');
});

add('A publishes a post that appears in the public feed', async () => {
  const created = await json<{ post: { id: string } }>('/api/posts', {
    method: 'POST',
    token: aliceToken,
    body: JSON.stringify({ body: `فحص نشر ${stamp} #فحص`, visibility: 'public' }),
  });
  postId = created.post.id;
  const feed = await json<{ items: Array<{ id: string }> }>('/api/feed?tab=for-you&limit=50', { token: aliceToken });
  if (!feed.items.some((p) => p.id === postId)) throw new Error('post missing from the public feed');
});

add('B can interact with the post', async () => {
  await json(`/api/posts/${postId}/like`, { method: 'POST', token: bobToken });
  await json(`/api/posts/${postId}/comments`, {
    method: 'POST',
    token: bobToken,
    body: JSON.stringify({ body: 'تعليق فحص' }),
  });
  const post = await json<{ post: { counts: { likes: number; comments: number } } }>(`/api/posts/${postId}`, { token: aliceToken });
  if (post.post.counts.likes !== 1 || post.post.counts.comments !== 1) {
    throw new Error(`unexpected counters: ${JSON.stringify(post.post.counts)}`);
  }
});

add('authentication is required for private data', async () => {
  const res = await fetch(`${API}/api/conversations`);
  if (res.status !== 401) throw new Error(`expected 401 without a token, got ${res.status}`);
});

let failed = 0;
console.log(`\nSmoke test against ${API}\n`);
for (const step of steps) {
  const started = Date.now();
  try {
    await step.run();
    console.log(`  ✓ ${step.name} (${Date.now() - started}ms)`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${step.name}: ${(err as Error).message}`);
  }
}
console.log(`\n${steps.length - failed}/${steps.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
