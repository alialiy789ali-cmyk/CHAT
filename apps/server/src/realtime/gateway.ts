import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, WS_CLOSE, WS_PATHS, decodeFrame, type ServerFrame } from '@sovereign/shared/protocol';
import { sendMessageSchema, editMessageSchema } from '@sovereign/shared/validation';
import { AppError } from '../lib/errors.js';
import type { ServiceContainer } from '../services/container.js';
import type { RequestContext } from '../services/context.js';
import type { ClientConnection } from './hub.js';

/**
 * WebSocket gateway.
 *
 * The gateway is attached directly to the HTTP server's `upgrade` event instead of
 * being a Fastify route: the handshake authenticates with a 90-second ticket, so it
 * does not participate in Fastify's HTTP pipeline, and this keeps the HTTP route
 * types (and the OpenAPI surface) clean.
 *
 * Handshake: `POST /api/auth/realtime-ticket` → `GET /ws?ticket=...`.
 * Every mutating frame is validated with the same zod schema as the REST API and then
 * executed by the same service layer — one implementation of every rule.
 */

interface ConnectionState {
  connection: ClientConnection | null;
  closed: boolean;
  frameCount: number;
  windowStartedAt: number;
}

const MAX_FRAMES_PER_MINUTE = 600;

export async function registerGateway(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { deps } = container;
  const wss = new WebSocketServer({ noServer: true, maxPayload: deps.cfg.WS_MAX_FRAME_BYTES, perMessageDeflate: false });
  /** Set during shutdown so late upgrades are rejected instead of touching a closed pool. */
  let shuttingDown = false;

  app.server.on('upgrade', (request: IncomingMessage, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATHS.gateway || shuttingDown) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    void handleConnection(socket, request);
  });

  async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const state: ConnectionState = { connection: null, closed: false, frameCount: 0, windowStartedAt: Date.now() };

    const send = (frame: ServerFrame) => {
      if (state.closed || socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        deps.logger.warn({ err }, 'ws send failed');
      }
    };

    const closeWith = (code: number, reason: string) => {
      state.closed = true;
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    };

    const fail = (code: string, message: string, closeCode?: number) => {
      send({ t: 'error', code, message });
      if (closeCode) closeWith(closeCode, message);
    };

    // ---------------------------------------------------------------- handshake
    let ticket: string | null = null;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      ticket = url.searchParams.get('ticket');
    } catch {
      ticket = null;
    }
    if (!ticket) {
      fail('unauthenticated', 'missing_ticket', WS_CLOSE.unauthenticated);
      return;
    }

    let claims;
    try {
      claims = await deps.tokens.verifyRealtimeTicket(ticket);
    } catch {
      fail('unauthenticated', 'invalid_ticket', WS_CLOSE.unauthenticated);
      return;
    }

    let session: Awaited<ReturnType<typeof deps.repos.sessions.findSession>>;
    let user: Awaited<ReturnType<typeof deps.repos.users.findById>>;
    try {
      session = await deps.repos.sessions.findSession(claims.sid);
      if (!session || session.revoked_at || session.user_id !== claims.sub || session.expires_at.getTime() < Date.now()) {
        fail('unauthenticated', 'session_not_active', WS_CLOSE.unauthenticated);
        return;
      }
      user = await deps.repos.users.findById(claims.sub);
    } catch (err) {
      // The database may already be closing (shutdown) — fail closed, never hang.
      deps.logger.warn({ err, userId: claims.sub }, 'ws handshake aborted');
      fail('service_unavailable', 'server_unavailable', WS_CLOSE.serverShutdown);
      return;
    }
    if (!user || user.status !== 'active') {
      fail('forbidden', 'account_not_active', WS_CLOSE.forbidden);
      return;
    }
    if (container.realtime.connectionCount(user.id) >= deps.cfg.WS_MAX_CONNECTIONS_PER_USER) {
      fail('rate_limited', 'too_many_connections', WS_CLOSE.tooManyConnections);
      return;
    }

    const forwardHeaders = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? '']),
    );
    const ctx: RequestContext = {
      ip: (forwardHeaders['x-forwarded-for']?.split(',')[0] ?? request.socket.remoteAddress ?? '').trim() || null,
      userAgent: forwardHeaders['user-agent'] ?? null,
      requestId: `ws_${Math.random().toString(36).slice(2, 10)}`,
      userId: user.id,
      sessionId: session.id,
    };

    const connection: ClientConnection = {
      id: `conn_${Math.random().toString(36).slice(2, 10)}`,
      userId: user.id,
      sessionId: session.id,
      deviceId: claims.did ?? session.device_id,
      send,
      close: closeWith,
      subscriptions: new Set<string>(),
      connectedAt: new Date(),
      lastSeenAt: new Date(),
    };
    state.connection = connection;
    container.realtime.register(connection);
    send(container.realtime.helloFrame(user.id, session.id));
    deps.logger.info({ userId: user.id, connectionId: connection.id, ip: ctx.ip }, 'ws connected');

    // ---------------------------------------------------------------- frames
    socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (!connection || state.closed) return;
      connection.lastSeenAt = new Date();

      // Basic abuse protection: cap frames per minute per connection.
      const now = Date.now();
      if (now - state.windowStartedAt > 60_000) {
        state.windowStartedAt = now;
        state.frameCount = 0;
      }
      state.frameCount += 1;
      if (state.frameCount > MAX_FRAMES_PER_MINUTE) {
        fail('rate_limited', 'too_many_frames', WS_CLOSE.slowConsumer);
        return;
      }

      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
      const frame = decodeFrame(text);
      if (!frame) {
        fail('bad_frame', 'frame_not_parseable');
        return;
      }

      try {
        switch (frame.t) {
          case 'hello': {
            if (frame.protocolVersion !== PROTOCOL_VERSION) {
              fail('protocol_version_mismatch', `server speaks v${PROTOCOL_VERSION}`, WS_CLOSE.protocolMismatch);
            }
            break;
          }
          case 'ping':
            send({ t: 'pong', ts: frame.ts, rid: frame.rid, serverTime: new Date().toISOString() });
            break;
          case 'subscribe': {
            for (const id of frame.conversationIds.slice(0, 200)) connection.subscriptions.add(id);
            send({ t: 'subscribed', conversationIds: [...connection.subscriptions] });
            break;
          }
          case 'unsubscribe': {
            for (const id of frame.conversationIds) connection.subscriptions.delete(id);
            send({ t: 'subscribed', conversationIds: [...connection.subscriptions] });
            break;
          }
          case 'message.send': {
            const input = sendMessageSchema.parse({
              clientMessageId: frame.clientMessageId,
              body: frame.body,
              replyToId: frame.replyToId ?? null,
              type: 'text',
            });
            const { message, duplicated } = await container.messaging.sendMessage({
              conversationId: frame.conversationId,
              senderId: user.id,
              clientMessageId: input.clientMessageId,
              body: input.body,
              type: input.type,
              replyToId: input.replyToId ?? null,
            });
            send({ t: 'ack', rid: frame.rid, of: 'message.send', data: { message, duplicated } });
            break;
          }
          case 'message.edit': {
            const input = editMessageSchema.parse({ body: frame.body });
            const message = await container.messaging.editMessage(frame.messageId, user.id, input.body);
            send({ t: 'ack', rid: frame.rid, of: 'message.edit', data: { message } });
            break;
          }
          case 'message.delete': {
            await container.messaging.deleteMessage(frame.messageId, user.id, ctx);
            send({ t: 'ack', rid: frame.rid, of: 'message.delete', data: { messageId: frame.messageId } });
            break;
          }
          case 'message.read': {
            const result = await container.messaging.markRead(frame.conversationId, user.id, frame.messageId);
            send({ t: 'ack', rid: frame.rid, of: 'message.read', data: result });
            break;
          }
          case 'message.delivered': {
            const result = await container.messaging.markDelivered(frame.messageIds.slice(0, 200), user.id);
            send({ t: 'ack', rid: frame.rid, of: 'message.delivered', data: result });
            break;
          }
          case 'typing': {
            await container.messaging.setTyping(frame.conversationId, user.id, frame.isTyping);
            break;
          }
          case 'call.signal': {
            const result = await container.calls.signal(user.id, frame.callId, frame.signal, frame.targetUserId);
            send({ t: 'ack', rid: frame.rid, of: 'call.signal', data: result });
            break;
          }
          case 'presence.subscribe':
            send({ t: 'ack', rid: frame.rid, of: 'presence.subscribe', data: { userIds: frame.userIds } });
            break;
          default:
            fail('unknown_frame', 'unsupported_frame_type');
        }
      } catch (err) {
        const appError = AppError.from(err);
        const rid = 'rid' in frame && typeof frame.rid === 'string' ? frame.rid : undefined;
        send({
          t: 'error',
          rid,
          code: appError.code,
          message: appError.expose ? appError.message : 'request_failed',
          details: appError.details,
        });
        if (appError.statusCode >= 500) {
          deps.logger.error({ err, userId: user.id, frame: frame.t }, 'ws frame failed');
        }
      }
    });

    socket.on('close', () => {
      if (state.connection) container.realtime.unregister(state.connection);
      state.closed = true;
      deps.logger.info({ userId: user.id, connectionId: connection.id }, 'ws disconnected');
    });

    socket.on('error', (err: Error) => {
      deps.logger.warn({ err, userId: user.id }, 'ws error');
    });
  }

  /**
   * `preClose` runs *before* Fastify closes the HTTP server. This is essential:
   * an upgraded WebSocket socket is detached from the HTTP server's connection list,
   * so the server would wait for it forever and `close()` would never resolve.
   * We therefore terminate every client and close the socket server here.
   */
  app.addHook('preClose', async () => {
    shuttingDown = true;
    const log = (message: string) => {
      if (process.env.SOVEREIGN_TRACE_CLOSE === 'true') console.log(`[ws-close] ${message}`);
    };
    log(`clients=${wss.clients.size}`);
    for (const client of wss.clients) client.terminate();
    log(`terminated; clients=${wss.clients.size}`);
    await new Promise<void>((resolve) => {
      // Never let a stuck socket block shutdown.
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      wss.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    log('wss closed');
  });
}
