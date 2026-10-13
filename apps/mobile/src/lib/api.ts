/**
 * Mobile API client.
 *
 * Differences from the web client, on purpose:
 *  - the refresh token is stored in the OS keychain (expo-secure-store) because there is
 *    no httpOnly cookie on React Native;
 *  - the base URL is configurable (a phone reaching your LAN server cannot use localhost);
 *  - retries are explicit and observable, so the UI can show "reconnecting" honestly.
 */
import * as SecureStore from 'expo-secure-store';

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8787').replace(/\/$/, '');
const REFRESH_KEY = 'sovereign.refreshToken';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = () => void;

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private unauthorizedListeners = new Set<Listener>();

  get baseUrl(): string {
    return API_URL;
  }

  get wsBaseUrl(): string {
    const configured = process.env.EXPO_PUBLIC_WS_URL;
    if (configured) return configured.replace(/\/$/, '');
    return API_URL.replace(/^http/, 'ws');
  }

  onUnauthorized(listener: Listener): () => void {
    this.unauthorizedListeners.add(listener);
    return () => this.unauthorizedListeners.delete(listener);
  }

  async restoreSession(): Promise<boolean> {
    this.refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    if (!this.refreshToken) return false;
    return this.refresh();
  }

  async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  }

  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (!this.refreshToken) return false;
        const res = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        if (!res.ok) {
          await this.clearTokens();
          return false;
        }
        const body = (await res.json()) as { accessToken: string; refreshToken?: string };
        await this.setTokens(body.accessToken, body.refreshToken ?? this.refreshToken);
        return true;
      } catch {
        // Network failure: keep the tokens, the caller decides whether to retry.
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, { ...init, headers });
    } catch (err) {
      throw new ApiError(0, 'network_unreachable', 'لا يمكن الوصول إلى الخادم. تحقق من الشبكة أو عنوان الخادم.', String(err));
    }

    if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
      const refreshed = await this.refresh();
      if (refreshed) return this.request<T>(path, init, false);
      for (const listener of this.unauthorizedListeners) listener();
    }

    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const body = text && isJson ? (JSON.parse(text) as unknown) : text;

    if (!res.ok) {
      const error = (isJson && body && typeof body === 'object' && 'error' in body
        ? (body as { error: { code: string; message: string; details?: unknown } }).error
        : { code: 'request_failed', message: String(body).slice(0, 200) }) as { code: string; message: string; details?: unknown };
      throw new ApiError(res.status, error.code, error.message, error.details);
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

  del<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * Absolute URL for a server path (`/api/files/:id` → `http://host:8787/api/files/:id`).
   * React Native has no same-origin concept, so every URL the API returns relative must be
   * resolved against the configured server before an <Image> can use it.
   */
  absoluteUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /**
   * Source object for React Native <Image>/<Video> with the access token attached.
   * Unlike a browser `<img>`, a native image request *can* carry headers — so no media token
   * or query-string credential is needed on mobile.
   */
  mediaSource(path: string | null | undefined): { uri: string; headers?: Record<string, string> } | undefined {
    if (!path) return undefined;
    const uri = this.absoluteUrl(path);
    return this.accessToken ? { uri, headers: { authorization: `Bearer ${this.accessToken}` } } : { uri };
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Uploads a local file (from expo-image-picker / expo-audio) as multipart. */
  async upload<T>(path: string, file: { uri: string; name: string; type: string }): Promise<T> {
    const form = new FormData();
    // React Native accepts this object shape for file parts; the cast keeps TS happy.
    form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    return this.request<T>(path, { method: 'POST', body: form });
  }
}

export const api = new ApiClient();
