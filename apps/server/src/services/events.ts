/**
 * Domain event bus.
 *
 * Services emit events; the realtime hub and the notification subsystem subscribe.
 * This keeps the messaging service free of transport concerns (no WebSocket code in
 * business logic) and makes the notification path testable in isolation.
 */

export type DomainEvent =
  | {
      type: 'message.created';
      conversationId: string;
      messageId: string;
      senderId: string;
      recipientIds: string[];
      /** Serialized message DTO so the hub never re-queries the database. */
      message?: unknown;
      at: Date;
      mentionIds?: string[];
    }
  | {
      type: 'message.updated';
      conversationId: string;
      messageId: string;
      recipientIds: string[];
      message?: unknown;
      at: Date;
    }
  | { type: 'message.deleted'; conversationId: string; messageId: string; recipientIds: string[]; at: Date }
  | {
      type: 'message.receipt';
      conversationId: string;
      messageIds: string[];
      userId: string;
      recipientIds: string[];
      state: 'delivered' | 'read';
      at: Date;
    }
  | { type: 'typing'; conversationId: string; userId: string; recipientIds: string[]; isTyping: boolean; at: Date }
  | { type: 'conversation.updated'; conversationId: string; recipientIds: string[]; reason: string; at: Date }
  | { type: 'presence.changed'; userId: string; online: boolean; lastSeenAt: Date | null; watcherIds: string[] }
  | { type: 'post.created'; postId: string; authorId: string; recipientIds: string[]; at: Date }
  | { type: 'post.liked'; postId: string; actorId: string; authorId: string; at: Date }
  | { type: 'post.commented'; postId: string; actorId: string; authorId: string; at: Date }
  | { type: 'user.followed'; followerId: string; followingId: string; at: Date }
  | { type: 'notification'; userId: string; kind: string; payload: Record<string, unknown>; at: Date }
  | { type: 'call.incoming'; callId: string; conversationId: string; initiatorId: string; kind: 'audio' | 'video'; participantIds: string[]; at: Date }
  | { type: 'call.updated'; callId: string; state: string; participantIds: string[]; actorId: string; at: Date }
  | { type: 'call.ended'; callId: string; state: string; participantIds: string[]; endedBy: string; reason: string; at: Date };

export type DomainEventType = DomainEvent['type'];
type Handler = (event: DomainEvent) => void | Promise<void>;

export class DomainEvents {
  private handlers = new Map<DomainEventType, Set<Handler>>();
  private wildcard = new Set<Handler>();

  on<T extends DomainEventType>(type: T, handler: (event: Extract<DomainEvent, { type: T }>) => void | Promise<void>): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(handler as Handler);
    this.handlers.set(type, set);
    return () => set.delete(handler as Handler);
  }

  onAny(handler: Handler): () => void {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  async emit(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    const tasks: Array<Promise<void>> = [];
    for (const handler of set ?? []) {
      tasks.push(Promise.resolve().then(() => handler(event)).catch(() => {}));
    }
    for (const handler of this.wildcard) {
      tasks.push(Promise.resolve().then(() => handler(event)).catch(() => {}));
    }
    // Handlers are isolated: a failing subscriber must never fail the request.
    await Promise.all(tasks);
  }
}
