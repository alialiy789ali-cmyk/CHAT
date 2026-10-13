'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

/**
 * Authenticated media URLs for the browser.
 *
 * Files are private: `GET /api/files/:id` refuses anonymous callers. `<img>`, `<video>`,
 * `<audio>` and plain download links cannot send an `Authorization` header, so the client
 * asks the API for a short-lived, read-only *media token* (5 minutes, `scope: files:read`)
 * and appends it as `?token=`. The token is kept in memory only, is refreshed before it
 * expires, and never grants write access — see apps/server/src/plugins/auth.ts.
 *
 * A fresh token is minted whenever the session changes (login, refresh, logout) so stale
 * URLs never survive a re-login.
 */

const REFRESH_MARGIN_MS = 45_000;

interface CachedToken {
  token: string;
  expiresAt: number;
  forAccessToken: string | null;
}

let cache: CachedToken | null = null;
let inflight: Promise<CachedToken | null> | null = null;

async function mint(accessToken: string | null): Promise<CachedToken | null> {
  if (cache && cache.forAccessToken === accessToken && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const result = await api.request<{ token: string; expiresIn: number }>('/api/auth/media-token', { method: 'POST' });
      cache = {
        token: result.token,
        expiresAt: Date.now() + result.expiresIn * 1000,
        forAccessToken: accessToken,
      };
      return cache;
    } catch {
      // Offline or signed out: components fall back to the un-tokened URL and the browser
      // shows its own broken-image state instead of the app crashing.
      cache = null;
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateMediaToken(): void {
  cache = null;
}

/** Public helper for non-component code (e.g. window.open for a download link). */
export async function withMediaToken(url: string): Promise<string> {
  if (!url.startsWith('/api/files/')) return url;
  const minted = await mint(api.getAccessToken());
  return minted ? appendToken(url, minted.token) : url;
}

function appendToken(url: string, token: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * Returns a media token for the current session, keeping it fresh while the component is
 * mounted. Resolves to `null` while loading or when signed out.
 */
export function useMediaToken(): string | null {
  const [token, setToken] = useState<string | null>(cache?.token ?? null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (expiresAt: number) => {
      const delay = Math.max(5_000, expiresAt - Date.now() - REFRESH_MARGIN_MS);
      timer = setTimeout(() => void load(), delay);
    };

    const load = async () => {
      const mintedToken = await mint(api.getAccessToken());
      if (cancelled) return;
      setToken(mintedToken?.token ?? null);
      if (mintedToken) schedule(mintedToken.expiresAt);
    };

    void load();
    // A new access token (login, silent refresh, re-login) means a new session generation:
    // drop the old media token so URLs cannot outlive the credentials they were minted with.
    const off = api.onTokenChange(() => {
      invalidateMediaToken();
      void load();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);

  return token;
}

/** Turns a stored `/api/files/:id` URL into one a browser tag can actually load. */
export function useMediaUrl(url: string | null | undefined): string | undefined {
  const token = useMediaToken();
  return useMemo(() => {
    if (!url) return undefined;
    if (!url.startsWith('/api/files/')) return url; // external/unauthenticated URL (e.g. a remote avatar)
    if (url.includes('token=')) return url;
    return token ? appendToken(url, token) : url;
  }, [url, token]);
}
