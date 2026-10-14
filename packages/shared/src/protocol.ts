/**
 * Realtime wire protocol (JSON frames over WebSocket).
 *
 * Design notes:
 *  - Every client frame may carry `rid` (request id); the server echoes it in the
 *    corresponding ack/error frame so clients can correlate without guessing.
 *  - The protocol is versioned (`PROTOCOL_VERSION`); a mismatch is rejected with
 *    code `protocol_version_mismatch` instead of failing silently.
 *  - Messages are never trusted from the socket: every mutating frame is validated
 *    with the same zod schemas used by the REST API, then goes through the same
 *    service layer. The socket is a transport, not a second source of truth.
 */

export const PROTOCOL_VERSION = 1;

export interface AttachmentPayload {
  id: string;
}

/** ---------------------------------------------------------------- client → server */

export type ClientFrame =
  | { t: 'hello'; protocolVersion: number; rid?: string }
  | { t: 'ping'; ts?: number; rid?: string }
  | { t: 'subscribe'; conversationIds: string[]; rid?: string }
  | { t: 'unsubscribe'; conversationIds: string[]; rid?: string }
  | {
      t: 'message.send';
      rid: string;
      clientMessageId: string;
      conversationId: string;
      body: string;
      replyToId?: string | null;
      type?: 'text';
    }
  | { t: 'message.edit'; rid: string; messageId: string; body: string }
  | { t: 'message.delete'; rid: string; messageId: string }
  | { t: 'message.read'; conversationId: string; messageId: string; rid?: string }
  | { t: 'message.delivered'; messageIds: string[]; rid?: string }
  | { t: 'typing'; conversationId: string; isTyping: boolean; rid?: string }
  | { t: 'presence.subscribe'; userIds: string[]; rid?: string }
  /** WebRTC signalling relay: the server forwards these opaque payloads verbatim. */
  | {
      t: 'call.signal';
      rid: string;
      callId: string;
      targetUserId?: string;
      signal:
        | { type: 'offer'; sdp: string }
        | { type: 'answer'; sdp: string }
        | { type: 'candidate'; candidate: unknown }
        | { type: 'renegotiate' }
        | { type: 'bye' };
    };

/** ---------------------------------------------------------------- server → client */

export interface ServerErrorFrame {
  t: 'error';
  rid?: string;
  code: string;
  message: string;
  details?: unknown;
}

export type ServerFrame =
  | { t: 'ready'; protocolVersion: number; userId: string; sessionId: string; serverTime: string }
  | { t: 'pong'; ts?: number; rid?: string; serverTime: string }
  | { t: 'ack'; rid?: string; of: string; data?: unknown }
  | { t: 'subscribed'; conversationIds: string[] }
  | { t: 'message'; conversationId: string; message: unknown }
  | { t: 'message.updated'; conversationId: string; message: unknown }
  | { t: 'message.deleted'; conversationId: string; messageId: string; deletedAt: string }
  | {
      t: 'receipt';
      conversationId: string;
      userId: string;
      messageId: string;
      state: 'delivered' | 'read';
      at: string;
    }
  | { t: 'typing'; conversationId: string; userId: string; isTyping: boolean; at: string }
  | { t: 'presence'; userId: string; online: boolean; lastSeenAt: string | null }
  | { t: 'conversation.updated'; conversationId: string; reason: string }
  | { t: 'notification'; kind: string; payload: unknown }
  | {
      t: 'call.signal';
      callId: string;
      fromUserId: string;
      signal:
        | { type: 'offer'; sdp: string }
        | { type: 'answer'; sdp: string }
        | { type: 'candidate'; candidate: unknown }
        | { type: 'renegotiate' }
        | { type: 'bye' };
    }
  | { t: 'error'; rid?: string; code: string; message: string; details?: unknown };

/** WebSocket close codes used by the server (application range 4000-4999). */
export const WS_CLOSE = {
  unauthenticated: 4401,
  forbidden: 4403,
  protocolMismatch: 4400,
  tooManyConnections: 4429,
  slowConsumer: 4408,
  serverShutdown: 4503,
} as const;

export const WS_PATHS = {
  gateway: '/ws',
} as const;

/** Heartbeat defaults (ms). The client should send `ping` every PING_INTERVAL. */
export const WS_HEARTBEAT = {
  pingInterval: 25_000,
  pongTimeout: 60_000,
} as const;

export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(raw: string): ClientFrame | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const t = (parsed as { t?: unknown }).t;
    if (typeof t !== 'string') return null;
    return parsed as ClientFrame;
  } catch {
    return null;
  }
}
