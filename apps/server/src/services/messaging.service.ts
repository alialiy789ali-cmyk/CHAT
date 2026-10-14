import { AppError, assert } from '../lib/errors.js';
import { normaliseClientMessageId } from '../lib/crypto.js';
import type { Attachment, Message } from '@sovereign/shared/types';
import type { AttachmentRow, MessageRow, MessageWithContextRow } from '../domain/messages.repo.js';
import { directKeyFor } from '../domain/conversations.repo.js';
import type { AppDeps, RequestContext } from './context.js';
import { messageToDto, conversationToDto, attachmentToDto } from './serializers.js';
import type { DomainEvents } from './events.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { Roles } from '../domain/roles.js';

/**
 * Messaging service — the vertical slice behind requirements 2.B.
 *
 * Invariants enforced here (not left to the transport layer):
 *  - only members can read or write in a conversation,
 *  - blocked pairs cannot exchange direct messages,
 *  - sends are idempotent per (conversation, sender, clientMessageId),
 *  - a message can only reply to / forward from a message of the same conversation,
 *  - attachments can only be attached once and only by their uploader,
 *  - receipts and typing are only accepted from members.
 */

export interface SendMessageInputDto {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  body: string;
  type?: MessageRow['type'];
  replyToId?: string | null;
  attachmentIds?: string[];
  mentions?: string[];
  ciphertext?: string | null;
  encryptionScheme?: 'none' | 'libsignal-v1' | 'olm-v1';
  /** Device issuing this send; used to return that device its own envelope. */
  senderDeviceId?: string | null;
  /** One envelope per recipient device (pairwise sessions cannot share one blob). */
  envelopes?: Array<{ deviceId: string; scheme: 'libsignal-v1' | 'olm-v1'; ciphertext: string }>;
}

export class MessagingService {
  constructor(
    private readonly deps: AppDeps,
    private readonly realtime: RealtimeHub,
    private readonly events: DomainEvents,
  ) {}

  private get conversations() {
    return this.deps.repos.conversations;
  }
  private get messages() {
    return this.deps.repos.messages;
  }
  private get files() {
    return this.deps.repos.files;
  }

  /** --------------------------------------------------------------- conversations */

  async listConversations(userId: string, limit = 50, cursor?: string) {
    const { items, nextCursor } = await this.conversations.listForUser(userId, limit, cursor);
    const peerIds = items
      .filter((c) => c.type === 'direct')
      .map((c) => c.direct_key?.split(':').find((id) => id !== userId))
      .filter((id): id is string => Boolean(id));
    const peers = peerIds.length ? await this.deps.repos.users.listByIds([...new Set(peerIds)]) : [];
    const peerMap = new Map(peers.map((p) => [p.id, p]));
    return {
      items: items.map((row) => {
        const peerId = row.direct_key?.split(':').find((id) => id !== userId);
        const peer = peerId ? peerMap.get(peerId) : null;
        return conversationToDto(
          row,
          userId,
          peer ? { username: peer.username, displayName: peer.display_name, avatarUrl: peer.avatar_url } : null,
        );
      }),
      nextCursor,
    };
  }

  async getConversation(conversationId: string, userId: string) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    const member = await this.conversations.member(conversationId, userId);
    if (!member || member.left_at) {
      if (conversation.type !== 'channel' || conversation.visibility !== 'public') {
        throw new AppError('not_member', 'not_a_member_of_conversation');
      }
    }
    const members = await this.conversations.membersWithRoles(conversationId);
    const peerId = conversation.direct_key?.split(':').find((id) => id !== userId);
    const peer = peerId ? await this.deps.repos.users.findById(peerId) : null;
    return {
      conversation: {
        ...conversationToDto(
          {
            ...conversation,
            member_count: String(members.length),
            my_role: member?.role ?? null,
            last_read_message_id: member?.last_read_message_id ?? null,
            unread_count: '0',
            last_message_id: null,
            last_message_body: null,
            last_message_type: null,
            last_message_at_effective: conversation.last_message_at,
            last_message_sender_id: null,
          },
          userId,
          peer ? { username: peer.username, displayName: peer.display_name, avatarUrl: peer.avatar_url } : null,
        ),
        members: members.map((m) => ({
          id: m.user_id,
          username: m.username,
          displayName: m.display_name,
          avatarUrl: m.avatar_url,
          role: m.role,
          joinedAt: m.joined_at.toISOString(),
          online: this.realtime.isOnline(m.user_id),
          lastSeenAt: m.last_seen_at ? m.last_seen_at.toISOString() : null,
        })),
      },
    };
  }

  async createDirectConversation(userId: string, otherUserId: string, ctx: RequestContext) {
    assert(userId !== otherUserId, 'self_action_not_allowed', 'cannot_message_yourself');
    const other = await this.deps.repos.users.findById(otherUserId);
    if (!other) throw new AppError('user_not_found');

    if (await this.deps.repos.social.blockExistsBetween(userId, otherUserId)) {
      throw new AppError('blocked_by_user', 'cannot_message_blocked_or_blocking_user');
    }
    // Privacy: whoCanMessage. 'contacts' means "we follow each other".
    const whoCanMessage = other.privacy_settings?.whoCanMessage ?? 'everyone';
    if (whoCanMessage === 'nobody') throw new AppError('cannot_message_user', 'user_does_not_accept_messages');
    if (whoCanMessage === 'contacts') {
      const mutual = await this.deps.repos.social.mutualFollow(userId, otherUserId);
      if (!mutual) throw new AppError('cannot_message_user', 'user_only_accepts_messages_from_contacts');
    }

    const { conversation, created } = await this.conversations.ensureDirect({ userA: userId, userB: otherUserId });
    await this.conversations.addMembers(conversation.id, [userId, otherUserId]);
    if (created) {
      await this.events.emit({
        type: 'conversation.updated',
        conversationId: conversation.id,
        recipientIds: [userId, otherUserId],
        reason: 'direct_created',
        at: new Date(),
      });
    }
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'conversation.direct_created',
      targetType: 'conversation',
      targetId: conversation.id,
      metadata: { created, peerId: otherUserId },
    });
    return this.getConversation(conversation.id, userId);
  }

  async createGroup(
    userId: string,
    input: { title: string; description?: string; memberIds: string[]; visibility: 'private' | 'public' },
    ctx: RequestContext,
  ) {
    const uniqueMembers = [...new Set(input.memberIds.filter((id) => id !== userId))];
    if (uniqueMembers.length > 0) {
      const found = await this.deps.repos.users.listByIds(uniqueMembers);
      assert(found.length === uniqueMembers.length, 'user_not_found', 'some_members_do_not_exist');
    }
    const conversation = await this.conversations.create({
      type: 'group',
      title: input.title,
      description: input.description ?? null,
      visibility: input.visibility,
      ownerId: userId,
    });
    await this.conversations.addMembers(conversation.id, [userId, ...uniqueMembers]);
    await this.conversations.setMemberRole(conversation.id, userId, 'owner');
    await this.messages.insert({
      conversationId: conversation.id,
      senderId: userId,
      clientMessageId: null,
      type: 'system',
      body: `created the group`,
      metadata: { event: 'group_created', actorId: userId },
    });
    await this.events.emit({
      type: 'conversation.updated',
      conversationId: conversation.id,
      recipientIds: [userId, ...uniqueMembers],
      reason: 'group_created',
      at: new Date(),
    });
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'conversation.group_created',
      targetType: 'conversation',
      targetId: conversation.id,
      metadata: { members: uniqueMembers.length },
    });
    return this.getConversation(conversation.id, userId);
  }

  async updateConversation(
    conversationId: string,
    userId: string,
    patch: { title?: string; description?: string | null; avatarUrl?: string | null; visibility?: 'private' | 'public' },
  ) {
    await this.requireRole(conversationId, userId, Roles.canManageConversation);
    const updated = await this.conversations.update(conversationId, patch);
    const recipientIds = await this.conversations.memberIds(conversationId);
    await this.events.emit({
      type: 'conversation.updated',
      conversationId,
      recipientIds,
      reason: 'settings_changed',
      at: new Date(),
    });
    return conversationToDto({ ...updated, member_count: String(recipientIds.length), my_role: null, last_read_message_id: null, unread_count: '0', last_message_id: null, last_message_body: null, last_message_type: null, last_message_at_effective: updated.last_message_at, last_message_sender_id: null }, userId);
  }

  async addMembers(conversationId: string, actorId: string, userIds: string[], ctx: RequestContext) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    if (conversation.type === 'direct') throw new AppError('conflict', 'cannot_add_members_to_direct');
    await this.requireRole(conversationId, actorId, Roles.canManageMembers);
    const existing = await this.conversations.memberIds(conversationId);
    const added = [...new Set(userIds)].filter((id) => !existing.includes(id));
    if (added.length === 0) return { added: [] };
    await this.conversations.addMembers(conversationId, added);
    await this.messages.insert({
      conversationId,
      senderId: actorId,
      clientMessageId: null,
      type: 'system',
      body: 'added members',
      metadata: { event: 'members_added', count: added.length },
    });
    await this.events.emit({
      type: 'conversation.updated',
      conversationId,
      recipientIds: [...existing, ...added],
      reason: 'members_added',
      at: new Date(),
    });
    await this.deps.repos.audit.record({
      actorId,
      actorIp: ctx.ip,
      action: 'conversation.members_added',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { count: added.length },
    });
    return { added };
  }

  async removeMember(conversationId: string, actorId: string, userId: string, ctx: RequestContext) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    if (userId === conversation.owner_id) throw new AppError('not_authorized_role', 'cannot_remove_owner');
    if (userId !== actorId) await this.requireRole(conversationId, actorId, Roles.canManageMembers);
    await this.conversations.removeMember(conversationId, userId);
    await this.messages.insert({
      conversationId,
      senderId: actorId,
      clientMessageId: null,
      type: 'system',
      body: 'removed a member',
      metadata: { event: 'member_removed', subjectId: userId },
    });
    const remaining = await this.conversations.memberIds(conversationId);
    await this.events.emit({
      type: 'conversation.updated',
      conversationId,
      recipientIds: [...remaining, userId],
      reason: 'member_removed',
      at: new Date(),
    });
    await this.deps.repos.audit.record({
      actorId,
      actorIp: ctx.ip,
      action: 'conversation.member_removed',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { subjectId: userId },
    });
  }

  async setMemberRole(conversationId: string, actorId: string, userId: string, role: 'admin' | 'moderator' | 'member' | 'subscriber', ctx: RequestContext) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    if (conversation.type === 'direct') throw new AppError('conflict', 'roles_not_supported_in_direct');
    await this.requireRole(conversationId, actorId, Roles.canAssignRoles);
    await this.conversations.setMemberRole(conversationId, userId, role);
    await this.deps.repos.audit.record({
      actorId,
      actorIp: ctx.ip,
      action: 'conversation.role_changed',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { subjectId: userId, role },
    });
    const recipientIds = await this.conversations.memberIds(conversationId);
    await this.events.emit({ type: 'conversation.updated', conversationId, recipientIds, reason: 'roles_changed', at: new Date() });
  }

  async leaveConversation(conversationId: string, userId: string) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    if (conversation.owner_id === userId) throw new AppError('not_owner', 'owner_must_transfer_or_delete');
    const isMember = await this.conversations.isMember(conversationId, userId);
    if (!isMember) throw new AppError('not_member');
    await this.conversations.removeMember(conversationId, userId);
    const recipientIds = await this.conversations.memberIds(conversationId);
    await this.events.emit({ type: 'conversation.updated', conversationId, recipientIds, reason: 'member_left', at: new Date() });
  }

  /** --------------------------------------------------------------- messages */

  async listMessages(
    conversationId: string,
    userId: string,
    params: { limit: number; cursor?: string; search?: string; viewerDeviceId?: string | null },
  ) {
    await this.requireMembership(conversationId, userId);
    const { items, nextCursor, hasMore } = await this.messages.list({
      conversationId,
      limit: params.limit,
      cursor: params.cursor,
      search: params.search ?? null,
    });
    const messageIds = items.map((i) => i.id);
    const [attachments, receipts] = await Promise.all([
      this.files.listForMessages(messageIds),
      this.messages.receiptsFor(messageIds),
    ]);
    const attachmentMap = groupBy(attachments, (a) => a.message_id ?? '');
    // Only this device's own envelopes are handed back: anything else is undecryptable
    // ciphertext and there is no reason to expose it.
    const envelopeMap = new Map<string, Array<{ deviceId: string; scheme: 'libsignal-v1' | 'olm-v1'; ciphertext: string }>>();
    if (params.viewerDeviceId) {
      for (const envelope of await this.messages.envelopesForDevice(messageIds, params.viewerDeviceId)) {
        const list = envelopeMap.get(envelope.message_id) ?? [];
        list.push({
          deviceId: params.viewerDeviceId,
          scheme: envelope.scheme as 'libsignal-v1' | 'olm-v1',
          ciphertext: envelope.ciphertext,
        });
        envelopeMap.set(envelope.message_id, list);
      }
    }
    const receiptMap = new Map<string, 'delivered' | 'read'>();
    for (const receipt of receipts) {
      const current = receiptMap.get(receipt.message_id);
      if (receipt.state === 'read' || !current) receiptMap.set(receipt.message_id, receipt.state);
    }
    return {
      items: items.map((row) =>
        messageToDto(row, attachmentMap.get(row.id) ?? [], receiptMap.get(row.id) ?? 'sent', envelopeMap.get(row.id) ?? []),
      ),
      nextCursor,
      hasMore,
    };
  }

  async getMessage(messageId: string, userId: string): Promise<Message> {
    const row = await this.messages.findById(messageId);
    if (!row) throw new AppError('message_not_found');
    await this.requireMembership(row.conversation_id, userId);
    const attachments = await this.files.listForMessage(messageId);
    return messageToDto(row, attachments);
  }

  async sendMessage(input: SendMessageInputDto): Promise<{ message: Message; duplicated: boolean }> {
    const conversation = await this.conversations.findById(input.conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    await this.requireMembership(input.conversationId, input.senderId);

    if (conversation.type === 'channel') {
      const member = await this.conversations.member(input.conversationId, input.senderId);
      if (!Roles.canPostInChannel(member?.role ?? null)) {
        throw new AppError('not_authorized_role', 'only_admins_can_post_in_channels');
      }
    }

    const clientMessageId = normaliseClientMessageId(input.clientMessageId);
    const attachmentIds = input.attachmentIds ?? [];
    const body = input.body ?? '';

    const envelopes = input.envelopes ?? [];
    const hasCiphertext = Boolean(input.ciphertext) || envelopes.length > 0;
    if (conversation.is_encrypted) {
      // Encryption is only honoured when the platform reports it as available.
      if (!this.deps.cfg.E2EE_ENABLED || !hasCiphertext) {
        throw new AppError('e2ee_not_available', 'encrypted_conversation_requires_ciphertext');
      }
    } else if (hasCiphertext) {
      // Never silently downgrade an attempt to send ciphertext into stored plaintext.
      throw new AppError('e2ee_not_available', 'e2ee_disabled_on_server');
    }

    // A sender may only address devices that belong to members of this conversation — a
    // message must not be able to deposit ciphertext into an unrelated person's inbox.
    if (envelopes.length > 0) {
      const memberIds = await this.deps.repos.conversations.memberIds(input.conversationId);
      const allowed = new Set<string>();
      for (const memberId of memberIds) {
        const devices = await this.deps.repos.keys.forUser(memberId);
        for (const device of devices) allowed.add(device.device_id);
      }
      const foreign = envelopes.filter((envelope) => !allowed.has(envelope.deviceId));
      assert(foreign.length === 0, 'validation_error', 'envelope_for_unknown_device');
    }

    // An encrypted message carries its content inside the ciphertext, so an empty body is
    // expected there; for plaintext conversations the content requirement still applies.
    assert(
      body.trim().length > 0 ||
        attachmentIds.length > 0 ||
        input.type === 'voice' ||
        (hasCiphertext && conversation.is_encrypted),
      'validation_error',
      'message_must_have_content',
    );
    assert(body.length <= 8000, 'validation_error', 'message_too_long');

    if (input.replyToId) {
      const replyTarget = await this.messages.findById(input.replyToId);
      assert(replyTarget?.conversation_id === input.conversationId, 'validation_error', 'reply_must_be_in_same_conversation');
    }

    const { message, duplicated } = await this.messages.insert({
      conversationId: input.conversationId,
      senderId: input.senderId,
      clientMessageId,
      type: input.type ?? (body.length > 0 ? 'text' : 'file'),
      body: body.length > 0 ? body : null,
      replyToId: input.replyToId ?? null,
      mentions: input.mentions ?? [],
      ciphertext: input.ciphertext ?? null,
      encryptionScheme: input.encryptionScheme ?? 'none',
    });

    if (envelopes.length > 0 && !duplicated) {
      await this.messages.insertEnvelopes(message.id, envelopes);
    }

    if (attachmentIds.length > 0 && !duplicated) {
      /**
       * A file and its message must agree about encryption.
       *
       * A readable file inside an encrypted conversation would leak precisely what that conversation
       * exists to protect, so only ciphertext uploads may be attached there. The reverse is refused
       * too: ciphertext in a plaintext conversation is a file nobody but the sender can open, which
       * is a broken send rather than a protected one.
       */
      const files = await this.deps.repos.files.listOwnedByIds(attachmentIds, input.senderId);
      assert(files.length === attachmentIds.length, 'validation_error', 'some_attachments_unavailable');
      const mismatched = files.filter((file) => file.is_encrypted !== conversation.is_encrypted);
      assert(
        mismatched.length === 0,
        'validation_error',
        conversation.is_encrypted ? 'encrypted_conversation_requires_encrypted_files' : 'plaintext_conversation_rejects_encrypted_files',
      );
      const attached = await this.messages.attachMessageToAttachments(message.id, attachmentIds, input.senderId);
      assert(attached === attachmentIds.length, 'validation_error', 'some_attachments_unavailable');
    }

    const full = await this.messages.findById(message.id);
    if (!full) throw new AppError('internal_error', 'message_vanished');
    const attachments = await this.files.listForMessage(message.id);
    const recipientIds = await this.messages.recipientsForDelivery(input.conversationId, input.senderId);

    // The sender gets back the envelope addressed to *their* device (present only if the
    // client encrypted a copy for itself, which is what multi-device clients do).
    const senderEnvelopes = input.senderDeviceId
      ? (await this.messages.envelopesForDevice([message.id], input.senderDeviceId)).map((envelope) => ({
          deviceId: input.senderDeviceId!,
          scheme: envelope.scheme as 'libsignal-v1' | 'olm-v1',
          ciphertext: envelope.ciphertext,
        }))
      : [];
    const dto = messageToDto(full, attachments, 'sent', senderEnvelopes);

    if (!duplicated) {
      // Mark as delivered for anyone currently connected; offline users get 'sent'.
      const online = recipientIds.filter((id) => this.realtime.isOnline(id));
      if (online.length > 0) {
        await this.messages.recordReceipts([message.id], online[0]!, 'delivered');
      }
      for (const recipientId of recipientIds) {
        await this.deps.repos.notifications.create({
          userId: recipientId,
          kind: input.mentions?.includes(recipientId) ? 'mention' : 'message',
          actorId: input.senderId,
          conversationId: input.conversationId,
          payload: { messageId: message.id, preview: body.slice(0, 120) },
        });
      }
      await this.events.emit({
        type: 'message.created',
        conversationId: input.conversationId,
        messageId: message.id,
        senderId: input.senderId,
        recipientIds,
        // Real-time fan-out is addressless: one frame reaches every device of every member, so it
        // must not carry a ciphertext addressed to one particular device. Receivers fetch their
        // own envelope (GET /api/messages/:id/envelope); the plaintext-metadata fields below are
        // all a notification needs.
        message: { ...dto, envelopes: [] },
        mentionIds: input.mentions ?? [],
        at: message.created_at,
      });
    }

    return { message: dto, duplicated };
  }

  async editMessage(messageId: string, actorId: string, body: string): Promise<Message> {
    assert(body.trim().length > 0 && body.length <= 8000, 'validation_error', 'message_body_invalid');
    const existing = await this.messages.findById(messageId);
    if (!existing) throw new AppError('message_not_found');
    if (existing.sender_id !== actorId) throw new AppError('forbidden', 'only_author_can_edit');
    if (existing.type === 'system') throw new AppError('forbidden', 'system_message_immutable');
    if (existing.deleted_at) throw new AppError('message_not_found', 'message_deleted');
    // Edit window: 48 hours (matches typical messenger behaviour and limits abuse).
    if (Date.now() - existing.created_at.getTime() > 48 * 3600 * 1000) {
      throw new AppError('forbidden', 'edit_window_expired');
    }
    // An edit carries plaintext. In the envelope model `messages.ciphertext` stays empty, so the
    // scheme column — not just the legacy column — has to decide this, or editing would quietly
    // write readable text into an encrypted conversation.
    if (existing.ciphertext || existing.encryption_scheme !== 'none') {
      throw new AppError('e2ee_not_available', 'cannot_edit_ciphertext_message');
    }

    const updated = await this.messages.updateBody(messageId, actorId, body);
    if (!updated) throw new AppError('message_not_found');
    const attachments = await this.files.listForMessage(messageId);
    const recipientIds = await this.conversations.memberIds(existing.conversation_id);
    const dto = messageToDto(updated, attachments);
    await this.events.emit({
      type: 'message.updated',
      conversationId: existing.conversation_id,
      messageId,
      recipientIds,
      message: dto,
      at: new Date(),
    });
    return dto;
  }

  async deleteMessage(messageId: string, actorId: string, ctx: RequestContext): Promise<{ deleted: true }> {
    const existing = await this.messages.findById(messageId);
    if (!existing) throw new AppError('message_not_found');
    const actor = await this.deps.repos.users.findById(actorId);
    const isAuthor = existing.sender_id === actorId;
    const isModerator = actor?.role === 'admin' || actor?.role === 'moderator';
    const conversationRole = (await this.conversations.member(existing.conversation_id, actorId))?.role ?? null;
    if (!isAuthor && !isModerator && !Roles.canDeleteAnyMessage(conversationRole)) {
      throw new AppError('forbidden', 'not_allowed_to_delete_message');
    }
    const deleted = await this.messages.softDelete(messageId, isAuthor ? actorId : null);
    if (!deleted) throw new AppError('message_not_found', 'message_already_deleted');
    const recipientIds = await this.conversations.memberIds(existing.conversation_id);
    await this.events.emit({
      type: 'message.deleted',
      conversationId: existing.conversation_id,
      messageId,
      recipientIds,
      at: new Date(),
    });
    await this.deps.repos.audit.record({
      actorId,
      actorIp: ctx.ip,
      action: isAuthor && !isModerator ? 'message.deleted_own' : 'message.deleted_by_moderator',
      targetType: 'message',
      targetId: messageId,
      metadata: { conversationId: existing.conversation_id },
    });
    return { deleted: true };
  }

  async forwardMessage(messageId: string, actorId: string, targetConversationId: string, clientMessageId: string): Promise<Message> {
    const source = await this.messages.findById(messageId);
    if (!source) throw new AppError('message_not_found');
    await this.requireMembership(source.conversation_id, actorId);
    const target = await this.conversations.findById(targetConversationId);
    assert(target, 'not_found', 'conversation_not_found');
    await this.requireMembership(targetConversationId, actorId);

    // A ciphertext is addressed to the devices of the original conversation. Copying it would
    // produce a bubble nobody can read (and copying the plaintext would break the sender's
    // encryption), so the client has to re-encrypt: it decrypts, then sends a fresh message.
    if (source.encryption_scheme !== 'none') {
      throw new AppError('e2ee_not_available', 'cannot_forward_ciphertext_message');
    }
    if (target.is_encrypted) {
      throw new AppError('e2ee_not_available', 'encrypted_conversation_requires_ciphertext');
    }

    const attachments = await this.files.listForMessage(messageId);
    // Attachments are copied by reference only within the same conversation; crossing
    // conversations would leak files, so forwards carry text and re-upload media.
    const sameConversation = source.conversation_id === targetConversationId;
    const { message } = await this.messages.insert({
      conversationId: targetConversationId,
      senderId: actorId,
      clientMessageId,
      type: source.type,
      body: source.body,
      forwardedFromId: messageId,
      metadata: { forwarded: true },
    });
    const recipientIds = await this.messages.recipientsForDelivery(targetConversationId, actorId);
    await this.events.emit({
      type: 'message.created',
      conversationId: targetConversationId,
      messageId: message.id,
      senderId: actorId,
      recipientIds,
      at: message.created_at,
    });
    const full = await this.messages.findById(message.id);
    return messageToDto(full!, sameConversation ? attachments : []);
  }

  /** --------------------------------------------------------------- receipts & typing */

  async markRead(conversationId: string, userId: string, messageId: string) {
    await this.requireMembership(conversationId, userId);
    const message = await this.messages.findById(messageId);
    if (!message || message.conversation_id !== conversationId) throw new AppError('message_not_found');
    const readIds = await this.messages.markReadUpTo(conversationId, userId, messageId);
    const recipientIds = await this.messages.recipientsForDelivery(conversationId, userId);
    if (readIds.length > 0) {
      await this.events.emit({
        type: 'message.receipt',
        conversationId,
        messageIds: readIds,
        userId,
        recipientIds,
        state: 'read',
        at: new Date(),
      });
    }
    return { readCount: readIds.length };
  }

  async markDelivered(messageIds: string[], userId: string) {
    if (messageIds.length === 0) return { delivered: 0 };
    const rows = await this.deps.db.many<{ conversation_id: string }>(
      'select distinct conversation_id from messages where id = any($1::uuid[])',
      [messageIds],
    );
    let delivered = 0;
    for (const row of rows) {
      if (!(await this.conversations.isMember(row.conversation_id, userId))) continue;
      const ids = await this.messages.recordReceipts(messageIds, userId, 'delivered');
      delivered += ids.length;
      const recipientIds = await this.messages.recipientsForDelivery(row.conversation_id, userId);
      if (ids.length > 0) {
        await this.events.emit({
          type: 'message.receipt',
          conversationId: row.conversation_id,
          messageIds: ids,
          userId,
          recipientIds,
          state: 'delivered',
          at: new Date(),
        });
      }
    }
    return { delivered };
  }

  async setTyping(conversationId: string, userId: string, isTyping: boolean) {
    await this.requireMembership(conversationId, userId);
    const recipientIds = await this.messages.recipientsForDelivery(conversationId, userId);
    await this.events.emit({ type: 'typing', conversationId, userId, recipientIds, isTyping, at: new Date() });
    return { ok: true };
  }

  async searchMessage(messageTerm: string, userId: string, limit = 20) {
    const rows = await this.messages.searchAcrossConversations(userId, messageTerm, limit);
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title,
      body: row.body,
      senderUsername: row.sender_username,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async unreadTotal(userId: string) {
    return { unread: await this.messages.countUnreadTotal(userId) };
  }

  /** --------------------------------------------------------------- helpers */

  private async requireMembership(conversationId: string, userId: string): Promise<void> {
    const isMember = await this.conversations.isMember(conversationId, userId);
    if (isMember) return;
    const conversation = await this.conversations.findById(conversationId);
    // Public channels can be read without joining (like a public Telegram channel).
    if (conversation?.type === 'channel' && conversation.visibility === 'public') return;
    throw new AppError('not_member', 'not_a_member_of_conversation');
  }

  private async requireRole(
    conversationId: string,
    userId: string,
    predicate: (role: string | null) => boolean,
  ): Promise<void> {
    const member = await this.conversations.member(conversationId, userId);
    if (!member || member.left_at) throw new AppError('not_member');
    if (!predicate(member.role)) throw new AppError('not_authorized_role');
  }

  /** Attachments uploaded by a user that are not yet attached to any message. */
  async pendingUploads(userId: string): Promise<Attachment[]> {
    const rows = await this.deps.db.many<AttachmentRow>(
      `select * from attachments
       where uploader_id = $1 and message_id is null and post_id is null and channel_post_id is null and deleted_at is null
       order by created_at desc limit 50`,
      [userId],
    );
    return rows.map(attachmentToDto);
  }

  static directKey = directKeyFor;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

export type { MessageWithContextRow };
