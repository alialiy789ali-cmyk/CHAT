import WebSocket from 'ws';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, WS_PATHS, type ClientFrame, type ServerFrame } from '@sovereign/shared/protocol';
import { e2e } from './setup-e2e.js';

/**
 * Thin HTTP + WebSocket clients used by the end-to-end tests. They speak exactly the
 * public protocol (no internal shortcuts), which is what makes the acceptance tests
 * meaningful: if these pass, a real client would work too.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

let userCounter = 0;

export function uniqueUsername(prefix = 'user'): string {
  userCounter += 1;
  return `${prefix}${Date.now().toString(36).slice(-5)}${userCounter}`.toLowerCase().slice(0, 24);
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}@example.test`.toLowerCase();
}

export class ApiClient {
  /** Public so a test can assert that a *previous* session's token was really revoked. */
  accessToken: string | null = null;
  refreshToken: string | null = null;
  userId: string | null = null;
  deviceId: string | null = null;
  username: string | null = null;
  email: string | null = null;

  constructor(private readonly baseUrl: string) {}

  get token(): string | null {
    return this.accessToken;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string | null; raw?: boolean; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const token = options.token === undefined ? this.accessToken : options.token;
    if (token) headers.authorization = `Bearer ${token}`;
    let body: RequestInit['body'] | undefined;
    if (options.body !== undefined) {
      if (options.raw) {
        body = options.body as RequestInit['body'];
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    let parsed: unknown = text;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && text) parsed = JSON.parse(text);
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  /**
   * Fetches bytes without decoding them. `request()` parses bodies as text/JSON, which would
   * corrupt binary payloads (this is how the media-download assertions verify real content).
   */
  async download(
    path: string,
    options: { token?: string | null; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const token = options.token === undefined ? this.accessToken : options.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${this.baseUrl}${path}`, { headers });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes: buffer, headers: response.headers };
  }

  async register(input?: {
    username?: string;
    email?: string;
    password?: string;
    displayName?: string;
    /** Stable install key (see migration 0007) so repeat logins reuse the same device row. */
    deviceKey?: string;
  }) {
    const username = input?.username ?? uniqueUsername();
    const email = input?.email ?? uniqueEmail(username);
    const password = input?.password ?? 'Sovereign-Test-Passw0rd';
    const res = await this.request<{
      user: { id: string; username: string };
      accessToken: string;
      refreshToken: string;
      deviceId: string;
    }>('POST', '/api/auth/register', {
      body: {
        username,
        email,
        password,
        displayName: input?.displayName ?? username,
        device: { name: 'Test runner', platform: 'web', key: input?.deviceKey },
      },
      token: null,
    });
    if (res.status !== 201) throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
    this.accessToken = res.body.accessToken;
    this.refreshToken = res.body.refreshToken;
    this.userId = res.body.user.id;
    this.deviceId = res.body.deviceId ?? null;
    this.username = res.body.user.username;
    this.email = email;
    return res.body;
  }

  async login(identifier: string, password: string, device?: { name?: string; key?: string }) {
    const res = await this.request<{
      accessToken: string;
      refreshToken: string;
      user: { id: string };
      deviceId: string;
      sessionId: string;
    }>('POST', '/api/auth/login', {
      body: {
        identifier,
        password,
        device: { name: device?.name ?? 'Second device', platform: 'web', key: device?.key },
      },
      token: null,
    });
    if (res.status !== 200) throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
    this.accessToken = res.body.accessToken;
    this.refreshToken = res.body.refreshToken;
    this.userId = res.body.user.id;
    this.deviceId = res.body.deviceId ?? null;
    return res.body;
  }

  async realtimeTicket(deviceId?: string): Promise<string> {
    const res = await this.request<{ ticket: string }>('POST', '/api/auth/realtime-ticket', {
      body: deviceId ? { deviceId } : {},
    });
    if (res.status !== 200) throw new Error(`ticket failed (${res.status})`);
    return res.body.ticket;
  }

  /** Opens a WebSocket using the public handshake. */
  async connect(): Promise<TestSocket> {
    const ticket = await this.realtimeTicket();
    const url = `${e2e().wsUrl}?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    const client = new TestSocket(socket);
    await client.waitForFrame((frame) => frame.t === 'ready');
    return client;
  }
}

/** Test wrapper around the server protocol with helpers to await specific frames. */
export class TestSocket {
  readonly frames: ServerFrame[] = [];
  private waiters: Array<{ match: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  readonly errors: ServerFrame[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw: Buffer) => {
      const frame = decodeFrame(raw.toString('utf8'));
      if (!frame) return;
      const asServer = frame as unknown as ServerFrame;
      this.frames.push(asServer);
      if (asServer.t === 'error') this.errors.push(asServer);
      const index = this.waiters.findIndex((w) => w.match(asServer));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(asServer);
      }
    });
    socket.on('close', () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('socket closed while waiting for a frame'));
      }
    });
  }

  send(frame: ClientFrame): void {
    this.socket.send(encodeFrame(frame));
  }

  hello(): void {
    this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
  }

  waitForFrame<T extends ServerFrame>(
    match: (frame: ServerFrame) => boolean,
    timeoutMs = 10_000,
    description = 'frame',
  ): Promise<T> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${description}; frames seen: ${this.frames.map((f) => f.t).join(',')}`));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => resolve(frame as T),
        reject,
        timer,
      });
    });
  }

  async waitForMessage(conversationId: string, predicate?: (message: unknown) => boolean): Promise<ServerFrame & { t: 'message' }> {
    return this.waitForFrame(
      (frame) => frame.t === 'message' && frame.conversationId === conversationId && (!predicate || predicate((frame as { message: unknown }).message)),
      10_000,
      `message in conversation ${conversationId}`,
    );
  }

  close(): void {
    this.socket.close();
  }
}

export const PASSWORD = 'Sovereign-Test-Passw0rd';
