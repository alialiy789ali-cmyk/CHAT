import type { ServerFrame } from '@sovereign/shared/protocol';
import { PROTOCOL_VERSION, WS_CLOSE } from '@sovereign/shared/protocol';
import type { AppDeps } from '../services/context.js';
import type { DomainEvent, DomainEvents } from '../services/events.js';
import { PUBSUB_CHANNELS } from '../lib/cache.js';

/**
 * Realtime hub.
 *
 * Responsibilities:
 *  - own the set of live WebSocket connections (per user, per instance),
 *  - translate domain events into protocol frames and deliver them,
 *  - fan out across API replicas through the cache/pub-sub driver (Redis in production,
 *    in-process in development) so multi-instance deployments behave identically,
 *  - track presence for online indicators.
 *
 * The hub never queries the database for payload shaping: services emit complete
 * events, which keeps fan-out O(connections) and free of N+1 queries.
 */

export interface ClientConnection {
  id: string;
  userId: string;
  sessionId: string;
  deviceId: string | null;
  send: (frame: ServerFrame) => void;
  close: (code: number, reason: string) => void;
  /** Conversations this connection explicitly subscribed to (used for typing scope). */
  subscriptions: Set<string>;
  connectedAt: Date;
  lastSeenAt: Date;
}

interface FanoutEnvelope {
  userIds: string[];
  frame: ServerFrame;
  originInstance: string;
}

export class RealtimeHub {
  private readonly connections = new Map<string, Set<ClientConnection>>();
  private readonly instanceId = `api-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private unsubscribe: (() => Promise<void>) | null = null;
  private started = false;

  constructor(
    private readonly deps: AppDeps,
    private readonly events: DomainEvents,
  ) {}

  isOnline(userId: string): boolean {
    const set = this.connections.get(userId);
    return Boolean(set && set.size > 0);
  }

  connectionCount(userId?: string): number {
    if (userId) return this.connections.get(userId)?.size ?? 0;
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Cross-instance delivery.
    this.unsubscribe = await this.deps.cache.subscribe(PUBSUB_CHANNELS.realtimeFanout, (_channel, payload) => {
      const envelope = payload as FanoutEnvelope;
      if (envelope.originInstance === this.instanceId) return; // already delivered locally
      for (const userId of envelope.userIds) this.deliverLocal(userId, envelope.frame);
    });

    // Domain events → protocol frames.
    this.events.onAny(async (event) => {
      const { userIds, frame } = this.mapEvent(event);
      if (userIds.length === 0 || !frame) return;
      await this.broadcast(userIds, frame);
    });

    this.deps.logger.info({ instanceId: this.instanceId }, 'realtime hub started');
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) await this.unsubscribe().catch(() => {});
    this.unsubscribe = null;
    for (const set of this.connections.values()) {
      for (const conn of set) conn.close(WS_CLOSE.serverShutdown, 'server_shutdown');
    }
    this.connections.clear();
    this.started = false;
    this.deps.logger.info('realtime hub stopped');
  }

  register(conn: ClientConnection): void {
    const set = this.connections.get(conn.userId) ?? new Set<ClientConnection>();
    set.add(conn);
    this.connections.set(conn.userId, set);
    void this.announcePresence(conn.userId, true);
  }

  unregister(conn: ClientConnection): void {
    const set = this.connections.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.connections.delete(conn.userId);
      void this.announcePresence(conn.userId, false);
      void this.deps.repos.users.touchLastSeen(conn.userId).catch(() => {});
    }
  }

  /** Sends a frame to every connection of a user, locally and on other instances. */
  async sendToUser(userId: string, frame: ServerFrame): Promise<void> {
    this.deliverLocal(userId, frame);
    await this.deps.cache.publish(PUBSUB_CHANNELS.realtimeFanout, {
      userIds: [userId],
      frame,
      originInstance: this.instanceId,
    } satisfies FanoutEnvelope);
  }

  async broadcast(userIds: string[], frame: ServerFrame): Promise<void> {
    const unique = [...new Set(userIds)];
    for (const userId of unique) this.deliverLocal(userId, frame);
    await this.deps.cache.publish(PUBSUB_CHANNELS.realtimeFanout, {
      userIds: unique,
      frame,
      originInstance: this.instanceId,
    } satisfies FanoutEnvelope);
  }

  private deliverLocal(userId: string, frame: ServerFrame): void {
    const set = this.connections.get(userId);
    if (!set) return;
    for (const conn of set) {
      try {
        conn.send(frame);
        conn.lastSeenAt = new Date();
      } catch (err) {
        this.deps.logger.warn({ err, userId, connectionId: conn.id }, 'failed to deliver frame');
      }
    }
  }

  private async announcePresence(userId: string, online: boolean): Promise<void> {
    // Watchers = everyone who shares a direct conversation with this user.
    const rows = await this.deps.db
      .many<{ user_id: string }>(
        `select cm2.user_id from conversation_members cm1
         join conversation_members cm2 on cm2.conversation_id = cm1.conversation_id
         join conversations c on c.id = cm1.conversation_id
         where cm1.user_id = $1 and cm2.user_id <> $1 and c.type = 'direct'`,
        [userId],
      )
      .catch(() => [] as Array<{ user_id: string }>);
    const watcherIds = rows.map((r) => r.user_id);
    if (watcherIds.length === 0) return;
    await this.broadcast(watcherIds, {
      t: 'presence',
      userId,
      online,
      lastSeenAt: online ? null : new Date().toISOString(),
    });
  }

  /** Maps a domain event to a protocol frame + recipients. */
  private mapEvent(event: DomainEvent): { userIds: string[]; frame: ServerFrame | null } {
    switch (event.type) {
      case 'message.created':
        return {
          userIds: [...event.recipientIds, event.senderId],
          frame: {
            t: 'message',
            conversationId: event.conversationId,
            message: event.message ?? { id: event.messageId },
          },
        };
      case 'message.updated':
        return {
          userIds: event.recipientIds,
          frame: {
            t: 'message.updated',
            conversationId: event.conversationId,
            message: event.message ?? { id: event.messageId },
          },
        };
      case 'message.deleted':
        return {
          userIds: event.recipientIds,
          frame: {
            t: 'message.deleted',
            conversationId: event.conversationId,
            messageId: event.messageId,
            deletedAt: event.at.toISOString(),
          },
        };
      case 'message.receipt':
        return {
          userIds: event.recipientIds,
          frame: {
            t: 'receipt',
            conversationId: event.conversationId,
            userId: event.userId,
            messageId: event.messageIds[event.messageIds.length - 1] as string,
            state: event.state,
            at: event.at.toISOString(),
          },
        };
      case 'typing':
        return {
          userIds: event.recipientIds,
          frame: {
            t: 'typing',
            conversationId: event.conversationId,
            userId: event.userId,
            isTyping: event.isTyping,
            at: event.at.toISOString(),
          },
        };
      case 'conversation.updated':
        return {
          userIds: event.recipientIds,
          frame: { t: 'conversation.updated', conversationId: event.conversationId, reason: event.reason },
        };
      case 'post.created':
        return {
          userIds: event.recipientIds,
          frame: { t: 'notification', kind: 'post.created', payload: { postId: event.postId, authorId: event.authorId } },
        };
      case 'post.liked':
      case 'post.commented':
      case 'user.followed':
        return {
          userIds: [
            event.type === 'user.followed' ? event.followingId : event.authorId,
          ],
          frame: { t: 'notification', kind: event.type, payload: { ...event } },
        };
      case 'notification':
        return { userIds: [event.userId], frame: { t: 'notification', kind: event.kind, payload: event.payload } };
      case 'call.incoming':
        return {
          userIds: event.participantIds,
          frame: {
            t: 'notification',
            kind: 'call.incoming',
            payload: {
              callId: event.callId,
              conversationId: event.conversationId,
              initiatorId: event.initiatorId,
              kind_: event.kind,
              at: event.at.toISOString(),
            },
          },
        };
      case 'call.updated':
        return {
          userIds: event.participantIds,
          frame: { t: 'notification', kind: 'call.updated', payload: { callId: event.callId, state: event.state, actorId: event.actorId } },
        };
      case 'call.ended':
        return {
          userIds: event.participantIds,
          frame: {
            t: 'notification',
            kind: 'call.ended',
            payload: { callId: event.callId, state: event.state, reason: event.reason, endedBy: event.endedBy },
          },
        };
      case 'presence.changed':
        return {
          userIds: event.watcherIds,
          frame: {
            t: 'presence',
            userId: event.userId,
            online: event.online,
            lastSeenAt: event.lastSeenAt ? event.lastSeenAt.toISOString() : null,
          },
        };
      default:
        return { userIds: [], frame: null };
    }
  }

  /** Relays an opaque WebRTC signalling payload to the other call participants. */
  async relayCallSignal(input: {
    callId: string;
    fromUserId: string;
    participantIds: string[];
    targetUserId?: string;
    signal: Extract<ServerFrame, { t: 'call.signal' }>['signal'];
  }): Promise<number> {
    const recipients = input.participantIds.filter((id) =>
      input.targetUserId ? id === input.targetUserId : id !== input.fromUserId,
    );
    if (recipients.length === 0) return 0;
    await this.broadcast(recipients, {
      t: 'call.signal',
      callId: input.callId,
      fromUserId: input.fromUserId,
      signal: input.signal,
    });
    return recipients.length;
  }

  helloFrame(userId: string, sessionId: string): ServerFrame {
    return {
      t: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      userId,
      sessionId,
      serverTime: new Date().toISOString(),
    };
  }
}
