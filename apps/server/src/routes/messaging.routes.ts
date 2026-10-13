import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  addMembersSchema,
  createDirectConversationSchema,
  createGroupSchema,
  editMessageSchema,
  forwardMessageSchema,
  markReadSchema,
  paginationSchema,
  sendMessageSchema,
  setMemberRoleSchema,
  updateConversationSchema,
  conversationEncryptionSchema,
} from '@sovereign/shared/validation';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';

function ctxOf(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId: request.auth?.userId,
    sessionId: request.auth?.sessionId,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conversations, messages, receipts and typing (requirement 2.B). */
export async function registerMessagingRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { messaging } = container;

  app.get('/conversations', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { limit, cursor } = paginationSchema.parse(request.query ?? {});
    return messaging.listConversations(request.auth!.userId, limit, cursor);
  });

  /** Encryption mode of a conversation and per-participant key readiness. */
  app.get('/conversations/:conversationId/encryption', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    return container.keys.encryptionStatus(conversationId, request.auth!.userId);
  });

  /** Turns E2EE on/off for a conversation (every member must have published keys first). */
  app.post('/conversations/:conversationId/encryption', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = conversationEncryptionSchema.parse(request.body ?? {});
    return container.keys.setConversationEncryption(conversationId, request.auth!.userId, body.enabled, ctxOf(request));
  });

  app.post('/conversations/direct', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const body = createDirectConversationSchema.parse(request.body ?? {});
    return messaging.createDirectConversation(request.auth!.userId, body.userId, ctxOf(request));
  });

  app.post('/conversations/group', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const body = createGroupSchema.parse(request.body ?? {});
    return messaging.createGroup(request.auth!.userId, body, ctxOf(request));
  });

  app.get('/conversations/:conversationId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    return messaging.getConversation(conversationId, request.auth!.userId);
  });

  app.patch('/conversations/:conversationId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = updateConversationSchema.parse(request.body ?? {});
    return messaging.updateConversation(conversationId, request.auth!.userId, body);
  });

  app.post('/conversations/:conversationId/members', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = addMembersSchema.parse(request.body ?? {});
    return messaging.addMembers(conversationId, request.auth!.userId, body.userIds, ctxOf(request));
  });

  app.delete('/conversations/:conversationId/members/:userId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId, userId } = request.params as { conversationId: string; userId: string };
    await messaging.removeMember(conversationId, request.auth!.userId, userId, ctxOf(request));
    return { removed: true };
  });

  app.post('/conversations/:conversationId/members/role', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = setMemberRoleSchema.parse(request.body ?? {});
    await messaging.setMemberRole(conversationId, request.auth!.userId, body.userId, body.role, ctxOf(request));
    return { updated: true };
  });

  app.post('/conversations/:conversationId/leave', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    await messaging.leaveConversation(conversationId, request.auth!.userId);
    return { left: true };
  });

  /** ------------------------------------------------------------- messages */

  app.get('/conversations/:conversationId/messages', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as Record<string, string | undefined>;
    const { limit, cursor } = paginationSchema.parse(query);
    return messaging.listMessages(conversationId, request.auth!.userId, {
      limit,
      cursor,
      search: query.q,
    });
  });

  app.post('/conversations/:conversationId/messages', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = sendMessageSchema.parse(request.body ?? {});
    const { message, duplicated } = await messaging.sendMessage({
      conversationId,
      senderId: request.auth!.userId,
      clientMessageId: body.clientMessageId,
      body: body.body,
      type: body.type,
      replyToId: body.replyToId ?? null,
      attachmentIds: body.attachmentIds,
      mentions: body.mentions,
      ciphertext: body.ciphertext ?? null,
      encryptionScheme: body.encryptionScheme,
    });
    // Idempotent retries return 200 with the existing message instead of duplicating.
    reply.status(duplicated ? 200 : 201);
    return { message, duplicated };
  });

  app.get('/messages/:messageId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { messageId } = request.params as { messageId: string };
    return messaging.getMessage(messageId, request.auth!.userId);
  });

  app.patch('/messages/:messageId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { messageId } = request.params as { messageId: string };
    const body = editMessageSchema.parse(request.body ?? {});
    return { message: await messaging.editMessage(messageId, request.auth!.userId, body.body) };
  });

  app.delete('/messages/:messageId', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { messageId } = request.params as { messageId: string };
    return messaging.deleteMessage(messageId, request.auth!.userId, ctxOf(request));
  });

  app.post('/messages/:messageId/forward', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const body = forwardMessageSchema.parse(request.body ?? {});
    const message = await messaging.forwardMessage(messageId, request.auth!.userId, body.targetConversationId, body.clientMessageId);
    reply.status(201);
    return { message };
  });

  app.post('/conversations/:conversationId/read', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = markReadSchema.parse(request.body ?? {});
    return messaging.markRead(conversationId, request.auth!.userId, body.messageId);
  });

  app.post('/messages/delivered', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const body = (request.body ?? {}) as { messageIds?: string[] };
    const ids = (body.messageIds ?? []).filter((id) => UUID_RE.test(id)).slice(0, 200);
    return messaging.markDelivered(ids, request.auth!.userId);
  });

  app.post('/conversations/:conversationId/typing', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = (request.body ?? {}) as { isTyping?: boolean };
    return messaging.setTyping(conversationId, request.auth!.userId, body.isTyping !== false);
  });

  app.get('/messages/search', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const term = (query.q ?? '').trim();
    if (term.length < 2) return [];
    return messaging.searchMessage(term, request.auth!.userId, 25);
  });

  app.get('/messages/unread-count', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) =>
    messaging.unreadTotal(request.auth!.userId),
  );

  app.get('/uploads/pending', { preHandler: [app.authenticate], schema: { tags: ['messaging'] } }, async (request) =>
    messaging.pendingUploads(request.auth!.userId),
  );
}
