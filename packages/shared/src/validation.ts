import { z } from 'zod';

/**
 * Single source of truth for input validation. The HTTP layer, the WebSocket
 * layer and the tests all import these schemas, so a rule can never be enforced
 * on one transport and forgotten on another.
 */

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'username_too_short')
  .max(24, 'username_too_long')
  .regex(/^[a-z][a-z0-9_]{2,23}$/, 'username_invalid');

export const passwordSchema = z
  .string()
  .min(10, 'password_too_short')
  .max(200, 'password_too_long')
  .refine((v) => /[a-z]/.test(v) || /[\u0600-\u06FF]/.test(v), 'password_needs_letter')
  .refine((v) => /[0-9]/.test(v), 'password_needs_digit')
  .refine((v) => !/^(.)\1+$/.test(v), 'password_too_simple');

export const emailSchema = z.string().trim().toLowerCase().min(5).max(254).email('email_invalid');

export const uuidSchema = z.string().uuid('invalid_uuid');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(60).optional(),
  inviteCode: z.string().max(64).optional(),
  device: z
    .object({
      name: z.string().trim().max(80).optional(),
      platform: z.enum(['web', 'android', 'ios', 'desktop', 'unknown']).default('web'),
    })
    .optional(),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^[0-9]{6}$/)
    .optional(),
  device: z
    .object({
      name: z.string().trim().max(80).optional(),
      platform: z.enum(['web', 'android', 'ios', 'desktop', 'unknown']).default('web'),
    })
    .optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(400).optional(),
});

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    bio: z.string().trim().max(300).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    locale: z.enum(['ar', 'en']).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
  })
  .strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const privacySettingsSchema = z
  .object({
    whoCanMessage: z.enum(['everyone', 'contacts', 'nobody']).optional(),
    whoCanSeeProfile: z.enum(['everyone', 'followers', 'nobody']).optional(),
    readReceipts: z.boolean().optional(),
    showOnlineStatus: z.boolean().optional(),
  })
  .strict();

export const createDirectConversationSchema = z.object({
  userId: uuidSchema,
});

export const createGroupSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  memberIds: z.array(uuidSchema).max(200).default([]),
  visibility: z.enum(['private', 'public']).default('private'),
});

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict();

export const addMembersSchema = z.object({ userIds: z.array(uuidSchema).min(1).max(200) });

export const setMemberRoleSchema = z.object({
  userId: uuidSchema,
  role: z.enum(['admin', 'moderator', 'member', 'subscriber']),
});

/** One ciphertext per recipient device — pairwise sessions cannot share a single blob. */
export const messageEnvelopeSchema = z.object({
  deviceId: uuidSchema,
  scheme: z.enum(['libsignal-v1', 'olm-v1']),
  ciphertext: z.string().min(1).max(200_000),
});

export const sendMessageSchema = z.object({
  clientMessageId: z.string().min(8).max(64),
  body: z.string().max(8000).default(''),
  type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file']).default('text'),
  replyToId: uuidSchema.nullable().optional(),
  attachmentIds: z.array(uuidSchema).max(10).default([]),
  mentions: z.array(uuidSchema).max(50).default([]),
  /**
   * E2EE payload. Either one envelope per recipient device (`envelopes`, the multi-device
   * correct form) or the legacy single `ciphertext`. Rejected outright while the server has
   * no E2EE session to protect — see docs/security-report.md.
   */
  ciphertext: z.string().max(200_000).nullable().optional(),
  encryptionScheme: z.enum(['none', 'libsignal-v1', 'olm-v1']).default('none'),
  envelopes: z.array(messageEnvelopeSchema).max(100).default([]),
});

export const editMessageSchema = z.object({ body: z.string().min(1).max(8000) });

export const markReadSchema = z.object({
  messageId: uuidSchema,
});

export const forwardMessageSchema = z.object({
  clientMessageId: z.string().min(8).max(64),
  targetConversationId: uuidSchema,
});

export const authHintSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
});

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordSchema,
});

export const twoFactorEnableSchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) });
export const twoFactorVerifySchema = twoFactorEnableSchema;

export const interactionSchema = z.object({ userId: uuidSchema });
export const blockSchema = interactionSchema;

export const realtimeTicketSchema = z.object({
  deviceId: uuidSchema.optional(),
});

/** ------------------------------------------------------------------ channels */

export const createChannelSchema = z.object({
  name: z.string().trim().min(3).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z][a-z0-9_]{2,39}$/, 'slug_invalid')
    .optional(),
  description: z.string().trim().max(400).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
});

export const createChannelPostSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  attachmentIds: z.array(uuidSchema).max(10).default([]),
});

export const channelInviteSchema = z.object({
  userId: uuidSchema.optional(),
  username: usernameSchema.optional(),
  role: z.enum(['admin', 'moderator', 'subscriber']).default('subscriber'),
  maxUses: z.coerce.number().int().min(1).max(1000).optional(),
  ttlHours: z.coerce.number().int().min(1).max(24 * 90).optional(),
});

/** ------------------------------------------------------------------ social */

export const createPostSchema = z.object({
  body: z.string().trim().max(4000).default(''),
  visibility: z.enum(['public', 'followers']).default('public'),
  attachmentIds: z.array(uuidSchema).max(10).default([]),
  replyToId: uuidSchema.nullable().optional(),
  quoteOfId: uuidSchema.nullable().optional(),
});

export const feedQuerySchema = z.object({
  tab: z.enum(['for-you', 'following', 'trending']).default('following'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  type: z.enum(['all', 'users', 'posts', 'channels']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const reportSchema = z.object({
  targetType: z.enum(['user', 'post', 'message', 'channel', 'comment']),
  targetId: uuidSchema,
  reason: z.enum(['spam', 'abuse', 'hate', 'sexual', 'violence', 'scam', 'other']),
  details: z.string().trim().max(1000).optional(),
});

export const moderationActionSchema = z.object({
  decision: z.enum(['dismissed', 'hidden', 'removed', 'user_warned', 'user_suspended']),
  note: z.string().trim().max(500).optional(),
});

export const notificationSettingsSchema = z
  .object({
    conversationNotifications: z.enum(['all', 'mentions', 'none']).optional(),
    pushEnabled: z.boolean().optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;

/* ---------------------------------------------------------------- E2EE key material */

/**
 * Base64 (with or without padding) as produced by the audited Signal library bindings.
 * Lengths are not pinned: key sizes differ between Curve25519 (32 bytes) and Kyber (1568).
 */
const base64Schema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'invalid_base64');

export const deviceKeyBundleSchema = z.object({
  /** Device the bundle belongs to; defaults to the session's device when omitted. */
  deviceId: uuidSchema.optional(),
  identityKey: base64Schema,
  registrationId: z.number().int().min(1).max(16383),
  signedPreKey: z.object({
    id: z.number().int().min(0).max(16_777_215),
    publicKey: base64Schema,
    signature: base64Schema,
  }),
  /** Kyber (post-quantum) prekey — required by libsignal v1 sessions. */
  kyberPreKey: z
    .object({
      id: z.number().int().min(0).max(16_777_215),
      publicKey: base64Schema,
      signature: base64Schema,
    })
    .optional(),
  oneTimePreKeys: z
    .array(
      z.object({
        id: z.number().int().min(0).max(16_777_215),
        publicKey: base64Schema,
      }),
    )
    .max(200)
    .default([]),
});

export const replenishPreKeysSchema = z.object({
  deviceId: uuidSchema.optional(),
  oneTimePreKeys: z
    .array(z.object({ id: z.number().int().min(0).max(16_777_215), publicKey: base64Schema }))
    .min(1)
    .max(200),
});

/**
 * Matrix Olm device bundle (web client).
 *
 * `identityKey` is the Curve25519 identity key, `signingKey` the Ed25519 key that signs it —
 * recipients MUST verify that signature before trusting the identity, which is what stops a
 * malicious server from substituting keys.
 */
export const olmDeviceKeySchema = z.object({
  deviceId: uuidSchema.optional(),
  algorithm: z.literal('olm-v1').default('olm-v1'),
  identityKey: base64Schema,
  signingKey: base64Schema,
  /** Ed25519 signature over the raw identity-key bytes. */
  signature: base64Schema,
  /** Olm allows at most 100 one-time keys; clients top the pool up as it drains. */
  oneTimeKeys: z
    .array(z.object({ id: z.string().min(1).max(64), key: base64Schema }))
    .min(1)
    .max(100),
});

export const olmReplenishSchema = z.object({
  deviceId: uuidSchema.optional(),
  oneTimeKeys: z.array(z.object({ id: z.string().min(1).max(64), key: base64Schema })).min(1).max(100),
});

export const deviceVerificationSchema = z.object({
  deviceId: uuidSchema,
  /** Safety number the verifier compared, formatted by the client. */
  fingerprint: z.string().trim().min(8).max(256),
  verified: z.boolean(),
});

export const conversationEncryptionSchema = z.object({ enabled: z.boolean() });

export type OlmDeviceKeyInput = z.infer<typeof olmDeviceKeySchema>;
export type MessageEnvelopeInput = z.infer<typeof messageEnvelopeSchema>;
export type DeviceKeyBundleInput = z.infer<typeof deviceKeyBundleSchema>;
export type DeviceVerificationInput = z.infer<typeof deviceVerificationSchema>;
