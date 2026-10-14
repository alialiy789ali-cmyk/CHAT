/**
 * Which server this install talks to.
 *
 * A phone is not a browser: `localhost` means the phone itself, and the build default
 * (`EXPO_PUBLIC_API_URL`) can only ever name one address baked in at build time. That is wrong for
 * the way this product is actually deployed — a self-hosted server on a LAN address today, a domain
 * with TLS tomorrow — and it is why every "just install the APK" story ends with a rebuild.
 *
 * So the address is runtime state, stored on the device:
 *
 *   build default  →  whatever this APK was compiled with (a sane starting point, often an emulator)
 *   saved override →  the address the user typed, kept in the OS keychain alongside the session
 *
 * The override is validated here rather than trusted: a typo like `192.168.1.20:8787` (no scheme) is
 * corrected to `http://192.168.1.20:8787`, a trailing slash is dropped, and anything that is not
 * http/https is refused — so the client never builds a URL it cannot fetch.
 */
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'sovereign.serverUrl';

/** The address compiled into this build. Overridable at build time (see docs/mobile-apk.md). */
export const DEFAULT_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8787').replace(/\/$/, '');

/**
 * The address in force right now.
 *
 * Module state rather than a hook: the API client is not a component, and every request reads it at
 * call time, so changing the address takes effect on the next call without re-mounting anything.
 */
let current = DEFAULT_API_URL;

export function currentApiUrl(): string {
  return current;
}

export interface ServerAddressResult {
  ok: boolean;
  /** The normalised address when `ok`, otherwise the reason a user can act on. */
  url?: string;
  error?: string;
}

/**
 * Validates and normalises what the user typed.
 *
 * A bare `host:port` is accepted and assumed to be `http://`, which is the common case while setting
 * the server up (a LAN address, no certificate yet). Paths are trimmed: an API origin is a host, and
 * silently keeping `/api` or `/foo` would produce URLs like `/foo/api/auth/login`.
 */
export function normaliseServerUrl(input: string): ServerAddressResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'أدخل عنوان الخادم.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: 'العنوان غير صالح. مثال: http://192.168.1.20:8787' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'يُقبل http أو https فقط.' };
  }
  if (!parsed.hostname) return { ok: false, error: 'العنوان بلا اسم مضيف.' };
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path && path !== '') {
    // Keep it, but say so: a reverse proxy can legitimately serve the API under a subpath.
    return { ok: true, url: `${parsed.origin}${path}` };
  }
  return { ok: true, url: parsed.origin };
}

export interface ServerProbe {
  reachable: boolean;
  /** Human-readable outcome — the login screen shows this instead of a generic failure. */
  detail: string;
  /** What the server calls itself, when it answered (proves it is *this* API, not any web server). */
  appName?: string;
  version?: string;
  /** True when the server answered but rejected the address for plain-HTTP reasons. */
  insecureRejected?: boolean;
}

/**
 * Asks the server to identify itself.
 *
 * `GET /api/health` is the cheapest real endpoint and returns the app name and version, so a wrong
 * address (a router page, another service on the same port) is distinguishable from an unreachable
 * one — that distinction is the whole difference between "fix your Wi-Fi" and "fix the URL".
 *
 * The timeout matters: without it a wrong LAN address leaves the user staring at a spinner until the
 * OS decides to give up.
 */
export async function probeServer(url: string, timeoutMs = 8000): Promise<ServerProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return { reachable: false, detail: `الخادم رد بالحالة ${response.status} على /api/health.` };
    }
    /**
     * Parsed by hand rather than with `response.json()`.
     *
     * A router page or an unrelated service answers 200 with HTML (sometimes still labelled JSON), and
     * `response.json()` would throw — turning "you pointed at the wrong thing" into a generic network
     * error and sending the user to check Wi-Fi instead of the address.
     */
    const text = await response.text();
    let body: { app?: string; version?: string; status?: string } | null = null;
    try {
      body = JSON.parse(text) as { app?: string; version?: string; status?: string };
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || body.status === undefined) {
      return { reachable: false, detail: 'العنوان يرد لكن ليس هذه الواجهة (لا يوجد /api/health بالشكل المتوقع).' };
    }
    return {
      reachable: true,
      detail: 'الخادم متاح.',
      appName: body.app ?? 'Sovereign',
      version: body.version,
    };
  } catch (error) {
    const aborted = (error as { name?: string } | null)?.name === 'AbortError';
    return {
      reachable: false,
      detail: aborted
        ? 'انتهت المهلة بلا رد — تأكد أن الجهاز على نفس الشبكة وأن المنفذ مفتوح.'
        : 'تعذّر الوصول. تحقق من العنوان أو الشبكة.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the saved override from the keychain and makes it current. Returns the address in force. */
export async function loadSavedServerUrl(): Promise<string> {
  try {
    const saved = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!saved) {
      current = DEFAULT_API_URL;
      return current;
    }
    const normalised = normaliseServerUrl(saved);
    current = normalised.ok ? normalised.url! : DEFAULT_API_URL;
    return current;
  } catch {
    // Keychain unavailable: fall back to the build default rather than failing to start.
    current = DEFAULT_API_URL;
    return current;
  }
}

/** Persists an override and applies it immediately. */
export async function saveServerUrl(input: string): Promise<ServerAddressResult> {
  const normalised = normaliseServerUrl(input);
  if (!normalised.ok) return normalised;
  await SecureStore.setItemAsync(STORAGE_KEY, normalised.url!);
  current = normalised.url!;
  return normalised;
}

/** Forgets the override; the build default takes over again. */
export async function clearServerUrl(): Promise<string> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
  current = DEFAULT_API_URL;
  return current;
}

/** True when this install points somewhere other than the address it was built with. */
export function usingOverride(): boolean {
  return current !== DEFAULT_API_URL;
}
