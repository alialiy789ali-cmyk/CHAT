/**
 * Domain types shared between the API server, the web client and (later) the mobile client.
 * These mirror the database schema documented in apps/server/src/db/migrations.
 */

export type UUID = string;

export type UserRole = 'user' | 'moderator' | 'admin';

export interface PublicUser {
  id: UUID;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  createdAt: string;
}

export interface SelfUser extends PublicUser {
  email: string;
  emailVerified: boolean;
  locale: 'ar' | 'en';
  theme: 'light' | 'dark' | 'system';
  twoFactorEnabled: boolean;
  role: UserRole;
}

export type ConversationType = 'direct' | 'group' | 'channel';

export type MemberRole = 'owner' | 'admin' | 'moderator' | 'member' | 'subscriber';

export interface ConversationSummary {
  id: UUID;
  type: ConversationType;
  title: string | null;
  description: string | null;
  avatarUrl: string | null;
  visibility: 'private' | 'public';
  ownerId: UUID | null;
  memberCount: number;
  lastMessageAt: string | null;
  lastReadMessageId: UUID | null;
  unreadCount: number;
  myRole: MemberRole | null;
  /** True only when the conversation is actually E2EE (see docs/SECURITY.md). */
  isEncrypted: boolean;
  createdAt: string;
}

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'file'
  | 'system';

export type MessageState = 'sent' | 'delivered' | 'read';

export interface Attachment {
  id: UUID;
  messageId: UUID | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sha256: string;
  createdAt: string;
}

export interface Message {
  id: UUID;
  conversationId: UUID;
  sender: PublicUser | null;
  clientMessageId: string | null;
  type: MessageType;
  body: string | null;
  replyToId: UUID | null;
  replyTo: Pick<Message, 'id' | 'body' | 'type'> & { senderUsername: string | null } | null;
  forwardedFromId: UUID | null;
  attachments: Attachment[];
  mentions: UUID[];
  /**
   * Opaque E2EE envelope (base64 of the serialized Signal message). The server stores and
   * relays it without being able to read it; only devices with the matching session keys can
   * decrypt it. `null` for ordinary plaintext messages.
   */
  ciphertext: string | null;
  encryptionScheme: 'none' | 'libsignal-v1';
  editedAt: string | null;
  deletedAt: string | null;
  state: MessageState;
  createdAt: string;
}

export interface Character {
  id: UUID;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  visibility: 'private' | 'public';
  ownerId: UUID;
  subscriberCount: number;
  isSubscribed: boolean;
  myRole: MemberRole | null;
  createdAt: string;
}

export interface Post {
  id: UUID;
  author: PublicUser;
  body: string;
  visibility: 'public' | 'followers';
  media: Attachment[];
  hashtags: string[];
  mentionUsernames: string[];
  replyToId: UUID | null;
  repostOfId: UUID | null;
  quoteOfId: UUID | null;
  repostOf: Post | null;
  counts: { likes: number; comments: number; reposts: number };
  viewer: { liked: boolean; reposted: boolean; following: boolean; isMine: boolean };
  editedAt: string | null;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SessionInfo {
  id: UUID;
  deviceId: UUID | null;
  deviceName: string | null;
  platform: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
