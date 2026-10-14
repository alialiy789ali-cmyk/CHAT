import type { AppConfig } from '../config/index.js';
import type { Logger } from './logger.js';

/**
 * Cache + pub/sub abstraction.
 *
 * Local development uses an in-process implementation (no external service, so the
 * platform can be run on a single machine). Production uses Redis, which also fans
 * realtime events out across API replicas. Both satisfy the same interface, so the
 * application code never branches on the driver.
 */

export type PubSubHandler = (channel: string, payload: unknown) => void;

export interface Cache {
  readonly driver: 'memory' | 'redis';
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment with TTL — used for rate limiting and attempt counters. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

export class MemoryCache implements Cache {
  readonly driver = 'memory' as const;
  private store = new Map<string, Entry>();
  private subscribers = new Map<string, Set<PubSubHandler>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor() {
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
      }
    }, 30_000);
    this.sweeper.unref?.();
  }

  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (entry.value as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    this.store.set(key, {
      value: next,
      expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000,
    });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry || entry.expiresAt === null) return -1;
    return Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(channel, payload);
      } catch {
        /* subscriber errors must not break the publisher */
      }
    }
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>> {
    const set = this.subscribers.get(channel) ?? new Set<PubSubHandler>();
    set.add(handler);
    this.subscribers.set(channel, set);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(channel);
    };
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.store.clear();
    this.subscribers.clear();
  }
}

type RedisClient = import('ioredis').Redis;

export class RedisCache implements Cache {
  readonly driver = 'redis' as const;
  private sub: RedisClient | null = null;
  private handlers = new Map<string, Set<PubSubHandler>>();

  constructor(
    private readonly pub: RedisClient,
    private readonly url: string,
    private readonly logger: Logger,
  ) {
    this.pub.on('error', (err: Error) => this.logger.error({ err }, 'redis error'));
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.pub.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) await this.pub.set(key, payload, 'EX', ttlSeconds);
    else await this.pub.set(key, payload);
  }

  async del(key: string): Promise<void> {
    await this.pub.del(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.pub.incr(key);
    if (count === 1) await this.pub.expire(key, ttlSeconds);
    return count;
  }

  async ttl(key: string): Promise<number> {
    return this.pub.ttl(key);
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(payload));
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>> {
    if (!this.sub) {
      const sub = await createRedisClient(this.url);
      this.sub = sub;
      sub.on('message', (ch: string, raw: string) => {
        for (const h of this.handlers.get(ch) ?? []) {
          try {
            h(ch, JSON.parse(raw));
          } catch (err) {
            this.logger.warn({ err, channel: ch }, 'pubsub handler failed');
          }
        }
      });
    }
    const set = this.handlers.get(channel) ?? new Set<PubSubHandler>();
    set.add(handler);
    this.handlers.set(channel, set);
    await this.sub.subscribe(channel);
    const currentSub = this.sub;
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await currentSub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    await this.sub?.quit().catch(() => {});
    await this.pub.quit().catch(() => {});
  }
}

/** Loads ioredis lazily so the dependency is only paid for when redis is enabled. */
async function createRedisClient(url: string): Promise<RedisClient> {
  const mod = (await import('ioredis')) as unknown as { default?: unknown; Redis?: unknown };
  const Ctor = (mod.default ?? mod.Redis ?? mod) as unknown as new (url: string, options?: object) => RedisClient;
  return new Ctor(url, { maxRetriesPerRequest: 2, lazyConnect: false });
}

export async function createCache(cfg: AppConfig, logger: Logger): Promise<Cache> {
  if (cfg.CACHE_DRIVER === 'redis') {
    try {
      const client = await createRedisClient(cfg.REDIS_URL);
      await client.ping();
      logger.info({ url: cfg.REDIS_URL.replace(/\/\/.*@/, '//***@') }, 'using redis cache');
      return new RedisCache(client, cfg.REDIS_URL, logger);
    } catch (err) {
      logger.warn({ err }, 'redis unavailable, falling back to in-memory cache');
    }
  }
  return new MemoryCache();
}

export const CACHE_KEYS = {
  loginAttempts: (identifier: string) => `auth:attempts:${identifier}`,
  loginAttemptsIp: (ip: string) => `auth:attempts:ip:${ip}`,
  rateLimit: (bucket: string, subject: string) => `rl:${bucket}:${subject}`,
  presence: (userId: string) => `presence:${userId}`,
  typing: (conversationId: string, userId: string) => `typing:${conversationId}:${userId}`,
  emailToken: (tokenHash: string) => `email:verify:${tokenHash}`,
  passwordReset: (tokenHash: string) => `pwreset:${tokenHash}`,
  totpPending: (userId: string) => `totp:pending:${userId}`,
  healthProbe: 'health:probe',
} as const;

export const PUBSUB_CHANNELS = {
  realtimeFanout: 'realtime:fanout',
  presence: 'presence:events',
} as const;
