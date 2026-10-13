import type { AppConfig } from '../config/index.js';
import type { Db } from '../db/pool.js';
import type { Cache } from '../lib/cache.js';
import type { Logger } from '../lib/logger.js';
import type { Mailer } from '../lib/mail.js';
import type { Storage } from '../lib/storage.js';
import type { AuditRepo } from '../domain/audit.repo.js';
import type { UsersRepo } from '../domain/users.repo.js';
import type { SessionsRepo } from '../domain/sessions.repo.js';
import type { ConversationsRepo } from '../domain/conversations.repo.js';
import type { MessagesRepo } from '../domain/messages.repo.js';
import type { FilesRepo } from '../domain/files.repo.js';
import type { ChannelsRepo } from '../domain/channels.repo.js';
import type { PostsRepo } from '../domain/posts.repo.js';
import type { SocialRepo } from '../domain/social.repo.js';
import type { ModerationRepo } from '../domain/moderation.repo.js';
import type { NotificationsRepo } from '../domain/notifications.repo.js';
import type { CallsRepo } from '../domain/calls.repo.js';
import type { KeysRepo } from '../domain/keys.repo.js';
import type { TokenService } from './tokens.service.js';

/** Per-request context carried into the service layer (never contains secrets). */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /** Authenticated user, when the route is protected. */
  userId?: string;
  sessionId?: string;
  deviceId?: string | null;
}

export interface RepoBundle {
  users: UsersRepo;
  sessions: SessionsRepo;
  audit: AuditRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  files: FilesRepo;
  channels: ChannelsRepo;
  posts: PostsRepo;
  social: SocialRepo;
  moderation: ModerationRepo;
  notifications: NotificationsRepo;
  calls: CallsRepo;
  keys: KeysRepo;
}

export interface AppDeps {
  cfg: AppConfig;
  db: Db;
  cache: Cache;
  logger: Logger;
  mailer: Mailer;
  storage: Storage;
  tokens: TokenService;
  repos: RepoBundle;
}

export function clientIp(headers: Record<string, unknown> | undefined, socketIp?: string | null): string | null {
  if (headers) {
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
    const realIp = headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) return realIp;
  }
  return socketIp ?? null;
}
