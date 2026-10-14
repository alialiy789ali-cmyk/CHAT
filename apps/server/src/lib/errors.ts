/**
 * Application error taxonomy.
 *
 * Every error surfaced to a client carries a stable machine-readable `code`
 * (used by clients and by the test-suite) plus a safe message. Internal details
 * are never leaked; unexpected errors become `internal_error` with a trace id.
 */

export type ErrorCode =
  // auth / sessions
  | 'invalid_credentials'
  | 'invalid_token'
  | 'token_expired'
  | 'unauthenticated'
  | 'forbidden'
  | 'account_suspended'
  | 'account_deactivated'
  | 'email_not_verified'
  | 'totp_required'
  | 'totp_invalid'
  | 'two_factor_already_enabled'
  | 'two_factor_not_enabled'
  | 'session_revoked'
  | 'too_many_sessions'
  | 'rate_limited'
  | 'captcha_required'
  // validation / input
  | 'validation_error'
  | 'invalid_uuid'
  | 'invalid_cursor'
  | 'unsupported_media_type'
  | 'payload_too_large'
  // domain
  | 'not_found'
  | 'user_not_found'
  | 'conversation_not_found'
  | 'message_not_found'
  | 'post_not_found'
  | 'channel_not_found'
  | 'username_taken'
  | 'email_taken'
  | 'slug_taken'
  | 'already_member'
  | 'not_member'
  | 'not_owner'
  | 'not_authorized_role'
  | 'cannot_message_user'
  | 'blocked_by_user'
  | 'self_action_not_allowed'
  | 'invite_invalid'
  | 'registration_closed'
  | 'conflict'
  | 'already_exists'
  | 'e2ee_not_available'
  // infrastructure
  | 'internal_error'
  | 'service_unavailable'
  | 'database_error'
  | 'storage_error';

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  invalid_credentials: 401,
  invalid_token: 401,
  token_expired: 401,
  unauthenticated: 401,
  two_factor_not_enabled: 409,
  totp_required: 401,
  totp_invalid: 401,
  account_suspended: 403,
  account_deactivated: 403,
  email_not_verified: 403,
  forbidden: 403,
  session_revoked: 401,
  too_many_sessions: 403,
  rate_limited: 429,
  captcha_required: 400,
  validation_error: 400,
  invalid_uuid: 400,
  invalid_cursor: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  not_found: 404,
  user_not_found: 404,
  conversation_not_found: 404,
  message_not_found: 404,
  post_not_found: 404,
  channel_not_found: 404,
  username_taken: 409,
  email_taken: 409,
  slug_taken: 409,
  already_member: 409,
  not_member: 403,
  not_owner: 403,
  not_authorized_role: 403,
  cannot_message_user: 403,
  blocked_by_user: 403,
  self_action_not_allowed: 400,
  invite_invalid: 400,
  registration_closed: 403,
  conflict: 409,
  already_exists: 409,
  e2ee_not_available: 501,
  internal_error: 500,
  service_unavailable: 503,
  database_error: 500,
  storage_error: 500,
  two_factor_already_enabled: 409,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    const status = STATUS_BY_CODE[code] ?? 400;
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = status;
    this.details = details;
    this.expose = status < 500;
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err && typeof err === 'object') {
      const maybe = err as { code?: string; statusCode?: number; message?: string; constraint?: string };
      // PostgreSQL unique violation
      if (maybe.code === '23505') {
        const constraint = maybe.constraint ?? '';
        const code: ErrorCode = constraint.includes('email')
          ? 'email_taken'
          : constraint.includes('username')
            ? 'username_taken'
            : constraint.includes('slug')
              ? 'slug_taken'
              : 'conflict';
        return new AppError(code, constraint || 'unique_violation');
      }
      if (maybe.code === '23503') return new AppError('not_found', 'referenced_row_missing');
      if (maybe.code === '57014') return new AppError('service_unavailable', 'query_timeout');
      if (typeof maybe.statusCode === 'number' && maybe.statusCode >= 400 && maybe.statusCode < 500) {
        return new AppError('validation_error', maybe.message ?? 'bad_request');
      }
    }
    return new AppError('internal_error', err instanceof Error ? err.message : 'unknown_error');
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function assert(condition: unknown, code: ErrorCode, message?: string, details?: unknown): asserts condition {
  if (!condition) throw new AppError(code, message, details);
}
