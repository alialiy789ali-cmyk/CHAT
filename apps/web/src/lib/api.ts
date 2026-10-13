/**
 * API client for the browser.
 *
 * Token strategy: the access token lives in memory only (never localStorage, so an
 * XSS cannot exfiltrate a long-lived credential); the refresh token is an httpOnly
 * cookie set by the API and sent automatically with `credentials: 'include'`.
 * On a 401 the client transparently refreshes once and retries the request.
 */

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiErrorPayload,
  ) {
    super(payload.message || payload.code);
    this.name = 'ApiError';
  }
}

type Listener = (state: { accessToken: string | null }) => void;

class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private listeners = new Set<Listener>();

  setAccessToken(token: string | null): void {
    this.accessToken = token;
    for (const listener of this.listeners) listener({ accessToken: token });
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  onTokenChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(path, { ...init, headers, credentials: 'include' });
  }

  /** Refreshes the access token exactly once even under concurrent 401s. */
  async refresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          this.setAccessToken(null);
          return false;
        }
        const body = (await res.json()) as { accessToken: string };
        this.setAccessToken(body.accessToken);
        return true;
      } catch {
        this.setAccessToken(null);
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const res = await this.raw(path, init);
    if (res.status === 401 && retry && !path.startsWith('/api/auth/refresh') && !path.startsWith('/api/auth/login')) {
      const refreshed = await this.refresh();
      if (refreshed) return this.request<T>(path, init, false);
    }
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const body = text && isJson ? (JSON.parse(text) as unknown) : text;
    if (!res.ok) {
      const payload = (isJson && body && typeof body === 'object' && 'error' in body
        ? (body as { error: ApiErrorPayload }).error
        : { code: 'request_failed', message: String(body).slice(0, 300) }) as ApiErrorPayload;
      throw new ApiError(res.status, payload);
    }
    return body as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
  }

  del<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'DELETE',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  upload<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: form });
  }

  /* ------------------------------------------------------------------ auth */

  async login(identifier: string, password: string, totp?: string) {
    const res = await this.post<{
      user: { id: string; username: string };
      accessToken: string;
    }>('/api/auth/login', { identifier, password, totp, device: { name: deviceName(), platform: 'web' } });
    this.setAccessToken(res.accessToken);
    return res;
  }

  async register(input: { username: string; email: string; password: string; displayName?: string }) {
    const res = await this.post<{ user: { id: string; username: string }; accessToken: string }>('/api/auth/register', {
      ...input,
      device: { name: deviceName(), platform: 'web' },
    });
    this.setAccessToken(res.accessToken);
    return res;
  }

  async logout(): Promise<void> {
    try {
      await this.post('/api/auth/logout');
    } finally {
      this.setAccessToken(null);
    }
  }

  /** Restores a session on page load using the refresh cookie. */
  async bootstrap(): Promise<{ id: string; username: string } | null> {
    const ok = await this.refresh();
    if (!ok) return null;
    try {
      const me = await this.get<{ id: string; username: string }>('/api/users/me');
      return me;
    } catch {
      return null;
    }
  }
}

function deviceName(): string {
  if (typeof navigator === 'undefined') return 'Web browser';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android browser';
  if (/iphone|ipad/i.test(ua)) return 'iPhone browser';
  if (/mac os/i.test(ua)) return 'macOS browser';
  if (/windows/i.test(ua)) return 'Windows browser';
  if (/linux/i.test(ua)) return 'Linux browser';
  return 'Web browser';
}

export const api = new ApiClient();
