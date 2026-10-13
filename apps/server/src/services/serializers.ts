import type { Attachment, Message, PublicUser } from '@sovereign/shared/types';
import type { AttachmentRow, MessageWithContextRow } from '../domain/messages.repo.js';
import type { UserRow } from '../domain/users.repo.js';
import type { ConversationSummaryRow } from '../domain/conversations.repo.js';
import type { PostWithAuthorRow } from '../domain/posts.repo.js';
import type { ChannelPostRow, ChannelRow } from '../domain/channels.repo.js';

/**
 * Row → DTO mappers. Response shapes are stable and typed in @sovereign/shared,
 * so the web and mobile clients cannot drift from the API.
 */

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function userToPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    isVerified: row.email_verified_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

export function attachmentToDto(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    // Files are always served through the authenticated API (never a public bucket URL).
    url: `/api/files/${row.id}`,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    sha256: row.sha256,
    createdAt: row.created_at.toISOString(),
  };
}

export function messageToDto(
  row: MessageWithContextRow,
  attachments: AttachmentRow[] = [],
  receiptState: 'sent' | 'delivered' | 'read' = 'sent',
): Message {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender_id
      ? {
          id: row.sender_id,
          username: row.sender_username ?? 'unknown',
          displayName: row.sender_display_name ?? row.sender_username ?? 'Unknown',
          bio: null,
          avatarUrl: row.sender_avatar_url,
          isVerified: false,
          createdAt: row.created_at.toISOString(),
        }
      : null,
    clientMessageId: row.client_message_id,
    type: row.type,
    body: deleted ? null : row.body,
    replyToId: row.reply_to_id,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          body: row.reply_body,
          type: (row.reply_type ?? 'text') as Message['type'],
          senderUsername: row.reply_sender_username,
        }
      : null,
    forwardedFromId: row.forwarded_from_id,
    attachments: deleted ? [] : attachments.map(attachmentToDto),
    mentions: row.mentions ?? [],
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    state: receiptState,
    createdAt: row.created_at.toISOString(),
  };
}

export function conversationToDto(
  row: ConversationSummaryRow,
  viewerId: string,
  peer?: { username: string; displayName: string; avatarUrl: string | null } | null,
) {
  return {
    id: row.id,
    type: row.type,
    // Direct conversations have no title in the DB: the client shows the peer's name.
    title: row.type === 'direct' ? (peer?.displayName ?? 'Direct message') : row.title,
    description: row.description,
    avatarUrl: row.type === 'direct' ? (peer?.avatarUrl ?? null) : row.avatar_url,
    peerUsername: peer?.username ?? null,
    visibility: row.visibility,
    ownerId: row.owner_id,
    memberCount: Number(row.member_count ?? 0),
    lastMessageAt: toIso(row.last_message_at_effective ?? row.last_message_at),
    lastReadMessageId: row.last_read_message_id,
    unreadCount: Number(row.unread_count ?? 0),
    myRole: row.my_role ?? null,
    isEncrypted: row.is_encrypted,
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          body: row.last_message_body,
          type: row.last_message_type,
          senderId: row.last_message_sender_id,
          isMine: row.last_message_sender_id === viewerId,
        }
      : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function postToDto(
  row: PostWithAuthorRow,
  media: AttachmentRow[] = [],
  viewerId: string | null = null,
): Record<string, unknown> {
  return {
    id: row.id,
    author: {
      id: row.author_id,
      username: row.author_username,
      displayName: row.author_display_name,
      bio: null,
      avatarUrl: row.author_avatar_url,
      isVerified: false,
      createdAt: (row.author_created_at ?? row.created_at).toISOString(),
    },
    body: row.body,
    visibility: row.visibility,
    media: media.map(attachmentToDto),
    hashtags: row.hashtags ?? [],
    mentionUsernames: row.mentions ?? [],
    replyToId: row.reply_to_id,
    repostOfId: row.repost_of_id,
    quoteOfId: row.quote_of_id,
    repostOf: row.repost_of_id
      ? {
          id: row.repost_of_id,
          body: row.repost_of_body,
          createdAt: row.repost_of_created_at ? row.repost_of_created_at.toISOString() : null,
          author: {
            username: row.repost_author_username,
            displayName: row.repost_author_display_name,
            avatarUrl: row.repost_author_avatar_url,
          },
        }
      : null,
    counts: {
      likes: row.like_count,
      comments: row.comment_count,
      reposts: row.repost_count,
    },
    viewer: {
      liked: Boolean(row.viewer_liked),
      reposted: Boolean(row.viewer_reposted),
      following: Boolean(row.viewer_following),
      isMine: viewerId !== null && row.author_id === viewerId,
    },
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function channelToDto(
  row: ChannelRow & { is_subscribed?: boolean; my_role?: string | null; last_read_post_at?: Date | null },
) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    avatarUrl: row.avatar_url,
    visibility: row.visibility,
    ownerId: row.owner_id,
    subscriberCount: Number(row.subscriber_count ?? 0),
    isSubscribed: Boolean(row.is_subscribed ?? false),
    myRole: row.my_role ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function channelPostToDto(
  row: ChannelPostRow & { author_username?: string | null; author_display_name?: string | null; author_avatar_url?: string | null },
  media: AttachmentRow[] = [],
) {
  return {
    id: row.id,
    channelId: row.channel_id,
    author: row.author_id
      ? {
          id: row.author_id,
          username: row.author_username ?? 'unknown',
          displayName: row.author_display_name ?? 'Unknown',
          avatarUrl: row.author_avatar_url ?? null,
        }
      : null,
    body: row.body,
    media: media.map(attachmentToDto),
    pinnedAt: row.pinned_at ? row.pinned_at.toISOString() : null,
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
