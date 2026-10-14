/**
 * Realtime client: typed wrapper over the WebSocket protocol with
 *  - ticket-based handshake (short-lived credential, refreshed on every connect),
 *  - automatic reconnect with exponential backoff and jitter,
 *  - resubscription to conversations after a reconnect,
 *  - pending-request bookkeeping so callers can await acknowledgements.
 */

import {
  PROTOCOL_VERSION,
  WS_HEARTBEAT,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from '@sovereign/shared/protocol';
import { api } from './api';

export type FrameHandler = (frame: ServerFrame) => void;

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private handlers = new Set<FrameHandler>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();
  private pending = new Map<string, { resolve: (frame: ServerFrame) => void; reject: (err: Error) => void; timer: number }>();
  private attempts = 0;
  private shouldRun = false;
  private pingTimer: number | null = null;
  private lastPong = 0;
  private subscribed = new Set<string>();
  private currentState: ConnectionState = 'closed';

  get state(): ConnectionState {
    return this.currentState;
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  onFrame(handler: FrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.shouldRun = true;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    await this.open();
  }

  private async open(): Promise<void> {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let ticket: string;
    try {
      const res = await api.post<{ ticket: string }>('/api/auth/realtime-ticket', {});
      ticket = res.ticket;
    } catch {
      this.scheduleReconnect();
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.lastPong = Date.now();
      this.setState('open');
      this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
      if (this.subscribed.size > 0) this.send({ t: 'subscribe', conversationIds: [...this.subscribed] });
      this.startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      const frame = decodeFrame(event.data);
      if (!frame) return;
      const serverFrame = frame as unknown as ServerFrame;
      if (serverFrame.t === 'pong') {
        this.lastPong = Date.now();
        if (serverFrame.rid) this.resolvePending(serverFrame);
        return;
      }
      if (serverFrame.t === 'ack' || serverFrame.t === 'error') {
        this.resolvePending(serverFrame);
      }
      for (const handler of this.handlers) {
        try {
          handler(serverFrame);
        } catch (err) {
          console.error('[realtime] handler failed', err);
        }
      }
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.setState('closed');
      if (this.shouldRun) this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* handled by onclose */
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    this.attempts += 1;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6));
    const delay = base / 2 + Math.random() * (base / 2);
    window.setTimeout(() => {
      if (this.shouldRun) void this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = window.setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > WS_HEARTBEAT.pongTimeout) {
        this.socket.close();
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, WS_HEARTBEAT.pingInterval);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private resolvePending(frame: ServerFrame): void {
    const rid = 'rid' in frame ? frame.rid : undefined;
    if (!rid) return;
    const waiter = this.pending.get(rid);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.pending.delete(rid);
    if (frame.t === 'error') waiter.reject(new Error(frame.message || frame.code));
    else waiter.resolve(frame);
  }

  send(frame: ClientFrame): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeFrame(frame));
  }

  /** Sends a frame that expects an `ack` with the same `rid`. */
  request<T = unknown>(frame: ClientFrame & { rid: string }, timeoutMs = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(frame.rid);
        reject(new Error('realtime_timeout'));
      }, timeoutMs);
      this.pending.set(frame.rid, {
        resolve: (response) => resolve(response as T),
        reject,
        timer,
      });
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        window.clearTimeout(timer);
        this.pending.delete(frame.rid);
        reject(new Error('realtime_offline'));
        return;
      }
      this.send(frame);
    });
  }

  subscribe(conversationIds: string[]): void {
    for (const id of conversationIds) this.subscribed.add(id);
    this.send({ t: 'subscribe', conversationIds });
  }

  unsubscribe(conversationIds: string[]): void {
    for (const id of conversationIds) this.subscribed.delete(id);
    this.send({ t: 'unsubscribe', conversationIds });
  }

  close(): void {
    this.shouldRun = false;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }
}

export const realtime = new RealtimeClient();

export function newRequestId(prefix = 'r'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newClientMessageId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
