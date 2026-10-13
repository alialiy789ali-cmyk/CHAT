import { loadConfig, type AppConfig } from './config/index.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createDatabase, type DatabaseHandle } from './db/pool.js';
import { embeddedDatabaseUrl, isEmbeddedRunning, startEmbedded } from './db/embedded.js';
import { runMigrations } from './db/migrate.js';
import { createCache, type Cache } from './lib/cache.js';
import { createStorage } from './lib/storage.js';
import { createMailer } from './lib/mail.js';
import { TokenService } from './services/tokens.service.js';
import { ServiceContainer } from './services/container.js';
import type { AppDeps, RepoBundle } from './services/context.js';
import { UsersRepo } from './domain/users.repo.js';
import { SessionsRepo } from './domain/sessions.repo.js';
import { AuditRepo } from './domain/audit.repo.js';
import { ConversationsRepo } from './domain/conversations.repo.js';
import { MessagesRepo } from './domain/messages.repo.js';
import { FilesRepo } from './domain/files.repo.js';
import { ChannelsRepo } from './domain/channels.repo.js';
import { PostsRepo } from './domain/posts.repo.js';
import { SocialRepo } from './domain/social.repo.js';
import { ModerationRepo } from './domain/moderation.repo.js';
import { NotificationsRepo } from './domain/notifications.repo.js';
import { CallsRepo } from './domain/calls.repo.js';
import { KeysRepo } from './domain/keys.repo.js';

/**
 * Runtime wiring: configuration → infrastructure → repositories → services.
 *
 * With no DATABASE_URL the server boots an embedded PostgreSQL instance so the whole
 * platform runs on a single machine (development, CI, air-gapped demo). With
 * DATABASE_URL set it connects to the owner's own PostgreSQL (production).
 */

export interface Runtime {
  cfg: AppConfig;
  logger: Logger;
  db: DatabaseHandle['db'];
  pool: DatabaseHandle['pool'];
  cache: Cache;
  deps: AppDeps;
  container: ServiceContainer;
  close: () => Promise<void>;
}

export interface CreateRuntimeOptions {
  env?: Record<string, string>;
  /** Skip migrations (tests that manage their own schema lifecycle). */
  skipMigrations?: boolean;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<Runtime> {
  const cfg = loadConfig(options.env ?? {});
  const logger = createLogger(cfg);

  let connectionString = cfg.DATABASE_URL ?? embeddedDatabaseUrl(cfg);
  if (!cfg.DATABASE_URL) {
    if (cfg.isProduction) throw new Error('DATABASE_URL is required in production');
    const already = await isEmbeddedRunning(cfg);
    if (!already) {
      logger.info({ port: cfg.EMBEDDED_PG_PORT }, 'starting embedded PostgreSQL (development database)');
      await startEmbedded(cfg, { createDatabase: 'sovereign' });
    } else {
      logger.info({ port: cfg.EMBEDDED_PG_PORT }, 'reusing running embedded PostgreSQL');
    }
    connectionString = embeddedDatabaseUrl(cfg);
  }

  const handle = await createDatabase(cfg, logger, connectionString);
  if (!options.skipMigrations) {
    const result = await runMigrations(handle.pool, logger);
    if (result.applied.length > 0) {
      logger.info({ applied: result.applied }, 'migrations applied');
    }
  }

  const cache = await createCache(cfg, logger);
  const storage = await createStorage(cfg, logger);
  const mailer = createMailer(cfg, logger);
  const tokens = new TokenService(cfg);

  const repos: RepoBundle = {
    users: new UsersRepo(handle.db),
    sessions: new SessionsRepo(handle.db),
    audit: new AuditRepo(handle.db),
    conversations: new ConversationsRepo(handle.db),
    messages: new MessagesRepo(handle.db),
    files: new FilesRepo(handle.db),
    channels: new ChannelsRepo(handle.db),
    posts: new PostsRepo(handle.db),
    social: new SocialRepo(handle.db),
    moderation: new ModerationRepo(handle.db),
    notifications: new NotificationsRepo(handle.db),
    calls: new CallsRepo(handle.db),
    keys: new KeysRepo(handle.db),
  };

  const deps: AppDeps = {
    cfg,
    db: handle.db,
    cache,
    logger,
    mailer,
    storage,
    tokens,
    repos,
  };

  const container = new ServiceContainer(deps);
  await container.start();

  return {
    cfg,
    logger,
    db: handle.db,
    pool: handle.pool,
    cache,
    deps,
    container,
    close: async () => {
      await container.stop().catch(() => {});
      await cache.close().catch(() => {});
      await handle.close().catch(() => {});
    },
  };
}
