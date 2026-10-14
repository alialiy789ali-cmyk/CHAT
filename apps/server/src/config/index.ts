import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Configuration is loaded once, validated with zod, and frozen.
 *
 * Sovereignty notes:
 *  - Every infrastructure dependency is pluggable (storage, cache, mail, database).
 *    The local development profile uses *no external service at all* (embedded
 *    PostgreSQL, filesystem object store, in-process cache, file-based mailer),
 *    while production profiles use self-hostable components (MinIO, Redis, SMTP).
 *  - Secrets are never committed: in development they are generated into
 *    `apps/server/var/` (git-ignored); in production they must be provided
 *    through the environment and the process refuses to boot with defaults.
 */

export type AppProfile = 'development' | 'test' | 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('Sovereign'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  /** Public URL of the API as seen by browsers (used for links in emails). */
  PUBLIC_API_URL: z.string().default('http://localhost:8787'),
  /** Comma separated list of allowed browser origins. Empty = permissive in dev only. */
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ---------------------------------------------------------------- database
  /** When set, connect to this PostgreSQL instead of the embedded one. */
  DATABASE_URL: z.string().optional(),
  /** Embedded PostgreSQL (development/test only). */
  EMBEDDED_PG_PORT: z.coerce.number().int().default(54329),
  EMBEDDED_PG_DATA_DIR: z.string().default('var/pgdata'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(15_000),

  // ---------------------------------------------------------------- drivers
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('var/storage'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('sovereign'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  MAIL_DRIVER: z.enum(['console', 'memory', 'file', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Sovereign <no-reply@sovereign.local>'),
  MAIL_OUTBOX_DIR: z.string().default('var/mail'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ---------------------------------------------------------------- auth
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  /**
   * Media tokens authorise *reads of one already-authorised file* for `<img>`/`<video>` tags,
   * which cannot send an Authorization header. Kept very short because the token travels in
   * the query string (and therefore into server logs).
   */
  MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().default(60 * 60 * 24 * 30),
  /** Comma separated emails that are promoted to admin on registration (bootstrap). */
  ADMIN_EMAILS: z.string().default(''),
  /** When false, accounts must verify their email before they can log in. */
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  /** Signups require an invite code (sovereignty / closed deployment mode). */
  REGISTRATION_INVITE_ONLY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  REGISTRATION_INVITE_CODE: z.string().optional(),
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(50).default(10),

  // ---------------------------------------------------------------- realtime
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).default(5),
  WS_MAX_FRAME_BYTES: z.coerce.number().int().default(256 * 1024),
  /** Comma separated list of allowed media origins (TURN/STUN/LiveKit). */
  RTC_ICE_SERVERS: z.string().default(''),
  RTC_TURN_URLS: z.string().default(''),
  RTC_TURN_USERNAME: z.string().optional(),
  RTC_TURN_CREDENTIAL: z.string().optional(),
  RTC_TURN_SECRET: z.string().optional(),
  RTC_TURN_TTL_SECONDS: z.coerce.number().int().default(3600),
  /** Self-hosted LiveKit (optional): when set, group calls return a room token. */
  RTC_LIVEKIT_URL: z.string().optional(),
  RTC_LIVEKIT_API_KEY: z.string().optional(),
  RTC_LIVEKIT_API_SECRET: z.string().optional(),

  // ---------------------------------------------------------------- limits
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().default(300),
  RATE_LIMIT_GLOBAL_WINDOW: z.string().default('1 minute'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().default(50 * 1024 * 1024),

  /**
   * Token for `GET /api/metrics`.
   *
   * Optional on purpose: without it the endpoint reports 404, so a deployment that never configured
   * monitoring exposes nothing at all. When set, a scraper must send it as `x-metrics-token` (or
   * `?token=`). Minimum length matches the other secrets so a guessable value cannot be configured
   * by accident.
   */
  METRICS_TOKEN: z.string().min(24).optional(),

  // ---------------------------------------------------------------- E2EE
  /**
   * End-to-end encryption is on by default: both ratchets (Signal for mobile, Matrix Olm for the
   * web client) are implemented and proven by the acceptance suite, and a server that quietly
   * accepted plaintext instead would weaken every conversation. Set `E2EE_ENABLED=false` only to
   * debug the unencrypted path — the API then *rejects* ciphertext rather than storing it as
   * readable text, so the downgrade is always visible.
   */
  E2EE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

export interface AppConfig extends z.infer<typeof envSchema> {
  profile: AppProfile;
  isProduction: boolean;
  isTest: boolean;
  rootDir: string;
  dataDir: string;
  secrets: {
    accessTokenSecret: string;
    refreshTokenSecret: string;
    ticketSecret: string;
    /** 32-byte base64 key used to encrypt TOTP secrets at rest. */
    fieldEncryptionKey: string;
    sessionSecret: string;
  };
  corsOrigins: string[];
  adminEmails: string[];
}

let cached: AppConfig | null = null;

function repoRoot(): string {
  // apps/server/src/config/index.ts -> repo root is four levels up.
  return path.resolve(import.meta.dirname, '../../../..');
}

function ensureDevSecret(name: string, dataDir: string): string {
  const secretDir = path.join(dataDir, 'secrets');
  const secretFile = path.join(secretDir, `${name}.key`);
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  if (cached) return cached;
  const env = { ...process.env, ...overrides } as Record<string, string | undefined>;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const raw = parsed.data;
  const profile = raw.NODE_ENV as AppProfile;
  const root = repoRoot();
  const dataDir = path.join(root, 'apps/server/var');

  // --- production guardrails: fail fast instead of silently using dev defaults.
  if (profile === 'production') {
    const problems: string[] = [];
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is required in production');
    if (profile === 'production' && (raw.STORAGE_DRIVER === 's3' ? !raw.S3_ACCESS_KEY : false))
      problems.push('S3_ACCESS_KEY/S3_SECRET_KEY are required when STORAGE_DRIVER=s3');
    if (raw.MAIL_DRIVER === 'smtp' && !raw.SMTP_HOST) problems.push('SMTP_HOST is required for MAIL_DRIVER=smtp');
    if (!env.CORS_ORIGINS) problems.push('CORS_ORIGINS is required in production');
    if (problems.length) throw new Error(`Production configuration errors:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  const pickSecret = (envName: string, devName: string) => {
    const fromEnv = env[envName];
    if (fromEnv && fromEnv.length >= 32) return fromEnv;
    if (profile === 'production') throw new Error(`${envName} must be set (>=32 chars) in production`);
    return ensureDevSecret(devName, dataDir);
  };

  const secrets = {
    accessTokenSecret: pickSecret('ACCESS_TOKEN_SECRET', 'access-token'),
    refreshTokenSecret: pickSecret('REFRESH_TOKEN_SECRET', 'refresh-token'),
    ticketSecret: pickSecret('REALTIME_TICKET_SECRET', 'realtime-ticket'),
    fieldEncryptionKey: pickSecret('FIELD_ENCRYPTION_KEY', 'field-encryption'),
    sessionSecret: pickSecret('SESSION_SECRET', 'session'),
  };

  cached = Object.freeze({
    ...raw,
    profile,
    isProduction: profile === 'production',
    isTest: profile === 'test',
    rootDir: root,
    dataDir,
    secrets: {
      ...secrets,
      // Derive a stable 32-byte key from the field encryption secret.
      fieldEncryptionKey: createHash('sha256').update(secrets.fieldEncryptionKey).digest('base64'),
    },
    corsOrigins: raw.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminEmails: raw.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  }) as AppConfig;
  return cached;
}

/** Test helper: drop the memoized config (used when tests start several profiles). */
export function resetConfigCache(): void {
  cached = null;
}

export function absolutePath(cfg: AppConfig, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cfg.rootDir, 'apps/server', p);
}

/** Redacted view of the configuration for the /health/details endpoint and logs. */
export function describeConfig(cfg: AppConfig) {
  return {
    profile: cfg.profile,
    appName: cfg.APP_NAME,
    database: cfg.DATABASE_URL ? 'external (DATABASE_URL)' : `embedded PostgreSQL on port ${cfg.EMBEDDED_PG_PORT}`,
    storage: cfg.STORAGE_DRIVER === 's3' ? `s3 (${cfg.S3_BUCKET} @ ${cfg.S3_ENDPOINT})` : 'local filesystem',
    cache: cfg.CACHE_DRIVER,
    mail: cfg.MAIL_DRIVER,
    e2eeEnabled: cfg.E2EE_ENABLED,
    corsOrigins: cfg.corsOrigins.length ? cfg.corsOrigins : '(dev: reflecting request origin)',
    uploadMaxBytes: cfg.UPLOAD_MAX_BYTES,
  };
}

export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
