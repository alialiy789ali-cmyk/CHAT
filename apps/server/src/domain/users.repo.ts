import type { Db } from '../db/pool.js';
import type { PrivacySettings, NotificationSettings } from './settings.js';

/**
 * Data access for users. All statements are parameterised; column lists are explicit
 * so that a schema change cannot silently leak a new sensitive column to clients.
 */

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  role: 'user' | 'moderator' | 'admin';
  status: 'active' | 'suspended' | 'deactivated' | 'deleted';
  email_verified_at: Date | null;
  locale: 'ar' | 'en';
  theme: 'light' | 'dark' | 'system';
  two_factor_secret_encrypted: string | null;
  two_factor_enabled_at: Date | null;
  privacy_settings: PrivacySettings;
  notification_settings: NotificationSettings;
  e2ee_ready: boolean;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const USER_COLUMNS = `
  id, username, email, password_hash, display_name, bio, avatar_url, role, status,
  email_verified_at, locale, theme, two_factor_secret_encrypted, two_factor_enabled_at,
  privacy_settings, notification_settings, e2ee_ready, last_seen_at, created_at, updated_at, deleted_at
`;

export function toPublicUser(row: Pick<UserRow, 'id' | 'username' | 'display_name' | 'bio' | 'avatar_url' | 'created_at'> & { is_verified?: boolean }) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    isVerified: Boolean(row.is_verified ?? false),
    createdAt: row.created_at.toISOString(),
  };
}

export function toSelfUser(row: UserRow) {
  return {
    ...toPublicUser(row),
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    locale: row.locale,
    theme: row.theme,
    twoFactorEnabled: row.two_factor_enabled_at !== null,
    role: row.role,
  };
}

export class UsersRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    username: string;
    email: string;
    passwordHash: string;
    displayName: string;
    role?: 'user' | 'moderator' | 'admin';
    locale?: 'ar' | 'en';
  }): Promise<UserRow> {
    return this.db.oneOrFail<UserRow>(
      `insert into users (username, email, password_hash, display_name, role, locale)
       values ($1, $2, $3, $4, $5, $6)
       returning ${USER_COLUMNS}`,
      [
        input.username,
        input.email,
        input.passwordHash,
        input.displayName,
        input.role ?? 'user',
        input.locale ?? 'ar',
      ],
      'user_not_found',
    );
  }

  findById(id: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(`select ${USER_COLUMNS} from users where id = $1 and deleted_at is null`, [id]);
  }

  findByUsername(username: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(
      `select ${USER_COLUMNS} from users where username = $1 and deleted_at is null`,
      [username],
    );
  }

  findByEmail(email: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(`select ${USER_COLUMNS} from users where email = $1 and deleted_at is null`, [email]);
  }

  findByIdentifier(identifier: string): Promise<UserRow | null> {
    const value = identifier.includes('@') ? identifier.toLowerCase() : identifier.toLowerCase();
    return this.db.one<UserRow>(
      `select ${USER_COLUMNS} from users where (email = $1 or username = $1) and deleted_at is null limit 1`,
      [value],
    );
  }

  async listByIds(ids: string[]): Promise<UserRow[]> {
    if (ids.length === 0) return [];
    return this.db.many<UserRow>(`select ${USER_COLUMNS} from users where id = any($1::uuid[])`, [ids]);
  }

  async updateProfile(
    id: string,
    patch: {
      displayName?: string;
      bio?: string | null;
      avatarUrl?: string | null;
      locale?: 'ar' | 'en';
      theme?: 'light' | 'dark' | 'system';
    },
  ): Promise<UserRow> {
    return this.db.oneOrFail<UserRow>(
      `update users set
         display_name = coalesce($2, display_name),
         bio = coalesce($3, bio),
         avatar_url = coalesce($4, avatar_url),
         locale = coalesce($5, locale),
         theme = coalesce($6, theme)
       where id = $1 and deleted_at is null
       returning ${USER_COLUMNS}`,
      [
        id,
        patch.displayName ?? null,
        patch.bio === undefined ? null : patch.bio,
        patch.avatarUrl === undefined ? null : patch.avatarUrl,
        patch.locale ?? null,
        patch.theme ?? null,
      ],
      'user_not_found',
    );
  }

  async updatePrivacy(id: string, patch: Partial<PrivacySettings>): Promise<UserRow> {
    return this.db.oneOrFail<UserRow>(
      `update users set privacy_settings = privacy_settings || $2::jsonb
       where id = $1 and deleted_at is null returning ${USER_COLUMNS}`,
      [id, JSON.stringify(patch)],
      'user_not_found',
    );
  }

  async updateNotificationSettings(id: string, patch: Partial<NotificationSettings>): Promise<UserRow> {
    return this.db.oneOrFail<UserRow>(
      `update users set notification_settings = notification_settings || $2::jsonb
       where id = $1 and deleted_at is null returning ${USER_COLUMNS}`,
      [id, JSON.stringify(patch)],
      'user_not_found',
    );
  }

  /**
   * Writes a new password hash. Deliberately *without* session side effects: this is also the
   * opportunistic KDF upgrade that runs during an ordinary login, and signing a user's other devices
   * out because they logged in would be a bug. The flows that end sessions on purpose
   * (`changePassword`, `resetPassword`) do it explicitly through the sessions repo.
   */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.query('update users set password_hash = $2 where id = $1', [id, passwordHash]);
  }

  async setEmailVerified(id: string): Promise<void> {
    await this.db.query('update users set email_verified_at = now() where id = $1', [id]);
  }

  async setTwoFactor(id: string, encryptedSecret: string | null, enabled: boolean): Promise<void> {
    await this.db.query(
      'update users set two_factor_secret_encrypted = $2, two_factor_enabled_at = case when $3 then now() else null end where id = $1',
      [id, encryptedSecret, enabled],
    );
  }

  async setStatus(id: string, status: UserRow['status']): Promise<void> {
    await this.db.query('update users set status = $2 where id = $1', [id, status]);
  }

  async touchLastSeen(id: string): Promise<void> {
    await this.db.query('update users set last_seen_at = now() where id = $1', [id]);
  }

  /** Full-text-ish search over username, display name and bio. */
  async search(term: string, limit: number, offset = 0): Promise<UserRow[]> {
    const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    return this.db.many<UserRow>(
      `select ${USER_COLUMNS} from users
       where deleted_at is null and status = 'active'
         and (username ilike $1 escape '\\' or display_name ilike $1 escape '\\' or coalesce(bio, '') ilike $1 escape '\\')
       order by (username ilike $2 escape '\\') desc, created_at desc
       limit $3 offset $4`,
      [like, `${term}%`, limit, offset],
    );
  }

  async deleteAccount(id: string, anonymisedUsername: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `update users set
           status = 'deleted', deleted_at = now(), bio = null, avatar_url = null,
           email = concat('deleted+', id, '@invalid.local'),
           username = $2, display_name = 'Deleted account',
           password_hash = 'deleted', two_factor_secret_encrypted = null, two_factor_enabled_at = null
         where id = $1`,
        [id, anonymisedUsername],
      );
      await tx.query('update sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null', [
        id,
        'account_deleted',
      ]);
      await tx.query('update devices set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await tx.query('delete from device_keys where user_id = $1', [id]);
      await tx.query('delete from follows where follower_id = $1 or following_id = $1', [id]);
    });
  }

  async statsFor(id: string) {
    return this.db.one<{ followers: string; following: string; posts: string }>(
      `select
         (select count(*) from follows where following_id = $1) as followers,
         (select count(*) from follows where follower_id = $1) as following,
         (select count(*) from posts where author_id = $1 and deleted_at is null) as posts`,
      [id],
    );
  }
}
