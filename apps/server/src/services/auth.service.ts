import * as OTPAuth from 'otpauth';
import { AppError, assert } from '../lib/errors.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../lib/crypto.js';
import { hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import { CACHE_KEYS } from '../lib/cache.js';
import { newDeviceEmail, verificationEmail, passwordResetEmail } from '../lib/mail.js';
import { passwordSchema, usernameSchema } from '@sovereign/shared/validation';
import { toSelfUser, type UserRow } from '../domain/users.repo.js';
import type { AppDeps, RequestContext } from './context.js';

/**
 * Authentication & account lifecycle.
 *
 * Security properties implemented here:
 *  - passwords hashed with Argon2id (scrypt fallback), never logged or returned,
 *  - login throttling per identifier *and* per IP backed by the cache driver,
 *  - refresh-token rotation with family-wide revocation on reuse (theft detection),
 *  - one-time email tokens stored as hashes with expiry,
 *  - TOTP two-factor with the shared secret encrypted at rest (AES-256-GCM),
 *  - every security-relevant action written to the audit log.
 */

export interface AuthResult {
  user: ReturnType<typeof toSelfUser>;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  deviceId: string | null;
  expiresIn: number;
}

const MAX_FAILED_ATTEMPTS = 8;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

export class AuthService {
  constructor(private readonly deps: AppDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** ------------------------------------------------------------------ register */

  async register(
    input: {
      username: string;
      email: string;
      password: string;
      displayName?: string;
      inviteCode?: string;
      device?: { name?: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'unknown' };
    },
    ctx: RequestContext,
  ): Promise<AuthResult> {
    const cfg = this.deps.cfg;
    const username = input.username.toLowerCase();

    // Re-validate in the service layer: the service must be safe even if a future
    // caller forgets to run the HTTP schema.
    assert(usernameSchema.safeParse(username).success, 'validation_error', 'username_invalid');
    assert(passwordSchema.safeParse(input.password).success, 'validation_error', 'password_policy');

    if (cfg.REGISTRATION_INVITE_ONLY) {
      if (!input.inviteCode || input.inviteCode !== cfg.REGISTRATION_INVITE_CODE) {
        throw new AppError('registration_closed', 'invite_code_required');
      }
    }

    const existingUsername = await this.deps.repos.users.findByUsername(username);
    if (existingUsername) throw new AppError('username_taken');
    const existingEmail = await this.deps.repos.users.findByEmail(input.email);
    if (existingEmail) throw new AppError('email_taken');

    const passwordHash = await hashPassword(input.password);
    const role = cfg.adminEmails.includes(input.email.toLowerCase()) ? 'admin' : 'user';
    const user = await this.deps.repos.users.create({
      username,
      email: input.email,
      passwordHash,
      displayName: input.displayName?.trim() || input.username,
      role,
    });

    await this.deps.repos.audit.record({
      actorId: user.id,
      actorIp: ctx.ip,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      metadata: { role, username },
    });

    await this.sendVerificationEmail(user);

    return this.createSessionFor(user, input.device, ctx, 'register');
  }

  async sendVerificationEmail(user: UserRow): Promise<string | null> {
    if (user.email_verified_at) return null;
    const token = randomToken(32);
    await this.deps.repos.sessions.createAuthToken({
      userId: user.id,
      kind: 'email_verify',
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const link = `${this.deps.cfg.PUBLIC_API_URL}/verify-email?token=${token}`;
    const mail = verificationEmail(user.display_name, link, user.locale);
    await this.deps.mailer.send({ ...mail, to: user.email });
    return token;
  }

  /** ------------------------------------------------------------------ login */

  async login(
    input: {
      identifier: string;
      password: string;
      totp?: string;
      device?: { name?: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'unknown' };
    },
    ctx: RequestContext,
  ): Promise<AuthResult> {
    const cfg = this.deps.cfg;
    const identifier = input.identifier.toLowerCase();
    await this.enforceLoginThrottle(identifier, ctx.ip);

    const user = await this.deps.repos.users.findByIdentifier(identifier);
    // Constant-ish work regardless of user existence (avoid user enumeration timing).
    const passwordOk = user
      ? await verifyPassword(input.password, user.password_hash)
      : await verifyPassword(input.password, 'scrypt$N=65536,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');

    if (!user || !passwordOk) {
      await this.deps.repos.sessions.recordLoginAttempt({ identifier, ip: ctx.ip, succeeded: false });
      await this.deps.repos.audit.record({
        actorId: user?.id ?? null,
        actorIp: ctx.ip,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        metadata: { identifier },
      });
      throw new AppError('invalid_credentials');
    }

    if (user.status === 'suspended') throw new AppError('account_suspended');
    if (user.status === 'deactivated' || user.status === 'deleted') throw new AppError('account_deactivated');
    if (cfg.REQUIRE_EMAIL_VERIFICATION && !user.email_verified_at) throw new AppError('email_not_verified');

    if (user.two_factor_enabled_at) {
      if (!input.totp) throw new AppError('totp_required');
      if (!this.verifyTotp(user, input.totp)) {
        await this.deps.repos.sessions.recordLoginAttempt({ identifier, ip: ctx.ip, succeeded: false });
        throw new AppError('totp_invalid');
      }
    }

    if (needsRehash(user.password_hash)) {
      // Opportunistic upgrade to the strongest available KDF.
      await this.deps.repos.users.updatePassword(user.id, await hashPassword(input.password));
      this.deps.logger.info({ userId: user.id }, 'password hash upgraded');
    }

    await this.deps.repos.sessions.recordLoginAttempt({ identifier, ip: ctx.ip, succeeded: true });
    await this.deps.repos.users.touchLastSeen(user.id);

    const result = await this.createSessionFor(user, input.device, ctx, 'login');
    if (input.device?.name) {
      const mail = newDeviceEmail(user.display_name, {
        device: input.device.name,
        ip: ctx.ip ?? 'unknown',
        at: new Date().toISOString(),
      });
      void this.deps.mailer.send({ ...mail, to: user.email }).catch(() => {});
    }
    return result;
  }

  private async enforceLoginThrottle(identifier: string, ip: string | null): Promise<void> {
    const byIdentifier = await this.deps.repos.sessions.recentFailures(identifier, 15);
    const byIp = ip ? await this.deps.repos.sessions.recentFailuresByIp(ip, 15) : 0;
    if (byIdentifier >= MAX_FAILED_ATTEMPTS || byIp >= MAX_FAILED_ATTEMPTS * 3) {
      this.deps.logger.warn({ identifier, ip, byIdentifier, byIp }, 'login throttled');
      throw new AppError('rate_limited', 'too_many_failed_attempts');
    }
    const cacheKey = CACHE_KEYS.loginAttempts(identifier);
    const attempts = await this.deps.cache.incr(cacheKey, ATTEMPT_WINDOW_SECONDS);
    if (attempts > MAX_FAILED_ATTEMPTS * 4) throw new AppError('rate_limited', 'too_many_login_attempts');
  }

  /** ------------------------------------------------------------------ sessions */

  private async createSessionFor(
    user: UserRow,
    device: { name?: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'unknown' } | undefined,
    ctx: RequestContext,
    origin: 'register' | 'login' | 'refresh',
  ): Promise<AuthResult> {
    const cfg = this.deps.cfg;
    const activeSessions = await this.deps.repos.sessions.countActiveSessions(user.id);
    if (activeSessions >= cfg.MAX_ACTIVE_SESSIONS) {
      throw new AppError('too_many_sessions', `maximum ${cfg.MAX_ACTIVE_SESSIONS} active sessions`);
    }

    const deviceRow = device?.name
      ? await this.deps.repos.sessions.createDevice({
          userId: user.id,
          name: device.name.slice(0, 80),
          platform: device.platform,
        })
      : await this.deps.repos.sessions.createDevice({
          userId: user.id,
          name: guessDeviceName(ctx.userAgent),
          platform: device?.platform ?? 'web',
        });

    const refresh = this.deps.tokens.issueRefreshToken();
    const session = await this.deps.repos.sessions.createSession({
      userId: user.id,
      deviceId: deviceRow.id,
      refreshTokenHash: refresh.hash,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      expiresAt: refresh.expiresAt,
    });
    const access = await this.deps.tokens.issueAccessToken({
      userId: user.id,
      sessionId: session.id,
      role: user.role,
    });

    this.deps.logger.info({ userId: user.id, sessionId: session.id, origin, ip: ctx.ip }, 'session created');
    await this.deps.repos.audit.record({
      actorId: user.id,
      actorIp: ctx.ip,
      action: `auth.session_created:${origin}`,
      targetType: 'session',
      targetId: session.id,
      metadata: { platform: deviceRow.platform },
    });

    return {
      user: toSelfUser(user),
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      sessionId: session.id,
      deviceId: deviceRow.id,
      expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthResult> {
    const hash = this.deps.tokens.hashRefreshToken(refreshToken);
    const session = await this.deps.repos.sessions.findByRefreshHash(hash);
    if (!session) throw new AppError('invalid_token', 'refresh_token_unknown');

    if (session.revoked_at) {
      // Reuse of a revoked token: revoke the whole family (possible theft).
      const revoked = await this.deps.repos.sessions.revokeFamily(session.refresh_token_family, 'token_reuse_detected');
      this.deps.logger.error({ userId: session.user_id, revoked }, 'refresh token reuse detected; family revoked');
      await this.deps.repos.audit.record({
        actorId: session.user_id,
        actorIp: ctx.ip,
        action: 'auth.token_reuse_detected',
        targetType: 'session',
        targetId: session.id,
        metadata: { revokedSessions: revoked },
      });
      throw new AppError('session_revoked', 'refresh_token_reuse');
    }
    if (session.expires_at.getTime() < Date.now()) throw new AppError('token_expired', 'refresh_token_expired');

    const user = await this.deps.repos.users.findById(session.user_id);
    if (!user) throw new AppError('invalid_token', 'session_user_missing');
    if (user.status !== 'active') throw new AppError('account_suspended');

    const next = this.deps.tokens.issueRefreshToken();
    await this.deps.repos.sessions.rotateSession(session.id, next.hash, next.expiresAt);
    if (session.device_id) await this.deps.repos.sessions.touchDevice(session.device_id);
    const access = await this.deps.tokens.issueAccessToken({
      userId: user.id,
      sessionId: session.id,
      role: user.role,
    });

    return {
      user: toSelfUser(user),
      accessToken: access.token,
      refreshToken: next.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: next.expiresAt.toISOString(),
      sessionId: session.id,
      deviceId: session.device_id,
      expiresIn: this.deps.cfg.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async logout(sessionId: string, ctx: RequestContext): Promise<void> {
    await this.deps.repos.sessions.revokeSession(sessionId, 'user_logout');
    await this.deps.repos.audit.record({
      actorId: ctx.userId ?? null,
      actorIp: ctx.ip,
      action: 'auth.logout',
      targetType: 'session',
      targetId: sessionId,
    });
  }

  async logoutAll(userId: string, ctx: RequestContext): Promise<number> {
    const sessions = await this.deps.repos.sessions.listSessions(userId);
    for (const session of sessions) {
      await this.deps.repos.sessions.revokeSession(session.id, 'logout_all');
    }
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: userId,
      metadata: { count: sessions.length },
    });
    return sessions.length;
  }

  listSessions(userId: string, currentSessionId?: string) {
    return this.deps.repos.sessions.listSessions(userId).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        platform: row.device_platform,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        current: row.id === currentSessionId,
      })),
    );
  }

  async revokeSession(userId: string, sessionId: string, ctx: RequestContext): Promise<void> {
    const session = await this.deps.repos.sessions.findSession(sessionId);
    if (!session || session.user_id !== userId) throw new AppError('not_found', 'session_not_found');
    await this.deps.repos.sessions.revokeSession(sessionId, 'user_revoked');
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'auth.session_revoked',
      targetType: 'session',
      targetId: sessionId,
    });
  }

  /** ------------------------------------------------------------------ email verification */

  async verifyEmail(token: string, ctx: RequestContext): Promise<{ verified: boolean }> {
    const consumed = await this.deps.repos.sessions.consumeAuthToken(sha256Hex(token), 'email_verify');
    if (!consumed) throw new AppError('invalid_token', 'verification_token_unknown');
    if (consumed.reused) throw new AppError('invalid_token', 'verification_token_used');
    if (consumed.expired) throw new AppError('token_expired', 'verification_token_expired');
    await this.deps.repos.users.setEmailVerified(consumed.user_id);
    await this.deps.repos.audit.record({
      actorId: consumed.user_id,
      actorIp: ctx.ip,
      action: 'auth.email_verified',
      targetType: 'user',
      targetId: consumed.user_id,
    });
    return { verified: true };
  }

  async resendVerification(identifier: string): Promise<void> {
    const user = await this.deps.repos.users.findByIdentifier(identifier);
    if (!user || user.email_verified_at) return; // do not leak account state
    await this.sendVerificationEmail(user);
  }

  /** ------------------------------------------------------------------ password reset */

  async requestPasswordReset(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.deps.repos.users.findByEmail(email);
    if (!user) return; // never reveal whether an account exists
    const token = randomToken(32);
    await this.deps.repos.sessions.createAuthToken({
      userId: user.id,
      kind: 'password_reset',
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    const link = `${this.deps.cfg.PUBLIC_API_URL}/reset-password?token=${token}`;
    const mail = passwordResetEmail(user.display_name, link, user.locale);
    await this.deps.mailer.send({ ...mail, to: user.email });
    await this.deps.repos.audit.record({
      actorId: user.id,
      actorIp: ctx.ip,
      action: 'auth.password_reset_requested',
      targetType: 'user',
      targetId: user.id,
    });
  }

  async resetPassword(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    assert(passwordSchema.safeParse(newPassword).success, 'validation_error', 'password_policy');
    const consumed = await this.deps.repos.sessions.consumeAuthToken(sha256Hex(token), 'password_reset');
    if (!consumed) throw new AppError('invalid_token', 'reset_token_unknown');
    if (consumed.reused) throw new AppError('invalid_token', 'reset_token_used');
    if (consumed.expired) throw new AppError('token_expired', 'reset_token_expired');
    await this.deps.repos.users.updatePassword(consumed.user_id, await hashPassword(newPassword));
    await this.deps.repos.audit.record({
      actorId: consumed.user_id,
      actorIp: ctx.ip,
      action: 'auth.password_reset_completed',
      targetType: 'user',
      targetId: consumed.user_id,
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    const ok = await verifyPassword(currentPassword, user.password_hash);
    if (!ok) throw new AppError('invalid_credentials', 'current_password_wrong');
    assert(passwordSchema.safeParse(newPassword).success, 'validation_error', 'password_policy');
    await this.deps.repos.users.updatePassword(userId, await hashPassword(newPassword));
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: userId,
    });
  }

  /** ------------------------------------------------------------------ two-factor (TOTP) */

  async setupTwoFactor(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    if (user.two_factor_enabled_at) throw new AppError('two_factor_already_enabled');
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: this.deps.cfg.APP_NAME,
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const encrypted = encryptField(secret.base32, this.deps.cfg.secrets.fieldEncryptionKey);
    await this.deps.cache.set(CACHE_KEYS.totpPending(userId), encrypted, 15 * 60);
    return { secret: secret.base32, otpauthUrl: totp.toString() };
  }

  async enableTwoFactor(userId: string, code: string, ctx: RequestContext): Promise<{ recoveryCodes: string[] }> {
    const pending = await this.deps.cache.get<string>(CACHE_KEYS.totpPending(userId));
    if (!pending) throw new AppError('two_factor_not_enabled', 'start_setup_first');
    const secretBase32 = decryptField(pending, this.deps.cfg.secrets.fieldEncryptionKey);
    if (!this.verifyTotpCode(secretBase32, code)) throw new AppError('totp_invalid');
    await this.deps.repos.users.setTwoFactor(userId, pending, true);
    await this.deps.cache.del(CACHE_KEYS.totpPending(userId));
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'auth.2fa_enabled',
      targetType: 'user',
      targetId: userId,
    });
    // Recovery codes are returned once and never stored in plaintext by the server.
    const recoveryCodes = Array.from({ length: 8 }, () => randomToken(10));
    await this.deps.cache.set(
      `2fa:recovery:${userId}`,
      recoveryCodes.map((c) => sha256Hex(c)),
      0,
    );
    return { recoveryCodes };
  }

  async disableTwoFactor(userId: string, password: string, ctx: RequestContext): Promise<void> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('user_not_found');
    if (!user.two_factor_enabled_at) throw new AppError('two_factor_not_enabled');
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw new AppError('invalid_credentials', 'password_wrong');
    await this.deps.repos.users.setTwoFactor(userId, null, false);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'auth.2fa_disabled',
      targetType: 'user',
      targetId: userId,
    });
  }

  /** Public check used by /auth/2fa/verify (no state change). */
  async verifyTwoFactorCode(userId: string, code: string): Promise<boolean> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) return false;
    return this.verifyTotp(user, code);
  }

  private verifyTotp(user: UserRow, code: string): boolean {
    if (!user.two_factor_secret_encrypted) return false;
    try {
      const secret = decryptField(user.two_factor_secret_encrypted, this.deps.cfg.secrets.fieldEncryptionKey);
      return this.verifyTotpCode(secret, code);
    } catch {
      return false;
    }
  }

  private verifyTotpCode(secretBase32: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      issuer: this.deps.cfg.APP_NAME,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    // window: 1 => accept the previous code too (clock skew tolerance).
    return totp.validate({ token: code, window: 1 }) !== null;
  }

  /** Verifies the caller is allowed to act (used by the auth guard as well). */
  async currentUser(userId: string): Promise<UserRow> {
    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('unauthenticated', 'user_missing');
    if (user.status === 'suspended') throw new AppError('account_suspended');
    if (user.status !== 'active') throw new AppError('account_deactivated');
    return user;
  }
}

function guessDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return 'Android device';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS device';
  if (ua.includes('mac os')) return 'macOS browser';
  if (ua.includes('windows')) return 'Windows browser';
  if (ua.includes('linux')) return 'Linux browser';
  if (ua.includes('node') || ua.includes('vitest')) return 'Test client';
  return 'Web browser';
}
