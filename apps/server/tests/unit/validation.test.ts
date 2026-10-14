import { describe, expect, it } from 'vitest';
import {
  createPostSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  sendMessageSchema,
  updateProfileSchema,
  usernameSchema,
} from '@sovereign/shared/validation';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@sovereign/shared/protocol';

/** The validation schemas are the contract between clients and the server. */

describe('username rules', () => {
  it('accepts valid usernames and normalises case', () => {
    for (const value of ['ali', 'ali_2026', 'a_b_c']) {
      expect(usernameSchema.safeParse(value).success).toBe(true);
    }
    // Usernames are case-insensitive: "Ali_2026" is stored as "ali_2026".
    expect(usernameSchema.parse('  Ali_2026 ')).toBe('ali_2026');
  });

  it('rejects invalid usernames with a machine-readable reason', () => {
    const cases: Array<[string, string]> = [
      ['ab', 'username_too_short'],
      ['9ali', 'username_invalid'],
      ['ali-ali', 'username_invalid'],
      ['ali ali', 'username_invalid'],
      ['a'.repeat(30), 'username_too_long'],
    ];
    for (const [value, code] of cases) {
      const result = usernameSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(code);
    }
  });
});

describe('password policy', () => {
  it('requires length, a letter and a digit', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('alllettersonly').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890').success).toBe(false);
    expect(passwordSchema.safeParse('Sovereign-2026').success).toBe(true);
    expect(passwordSchema.safeParse('كلمةمرور1قوية').success).toBe(true);
  });
});

describe('registration and login payloads', () => {
  it('normalises email casing and trims the username', () => {
    const parsed = registerSchema.parse({
      username: '  Ali_2026 ',
      email: '  User@Example.COM ',
      password: 'Sovereign-2026',
    });
    expect(parsed.username).toBe('ali_2026');
    expect(parsed.email).toBe('user@example.com');
  });

  it('rejects unknown fields on strict schemas', () => {
    expect(updateProfileSchema.safeParse({ displayName: 'Ali', hack: true }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ displayName: 'Ali' }).success).toBe(true);
  });

  it('requires a six digit TOTP when provided', () => {
    expect(loginSchema.safeParse({ identifier: 'ali', password: 'x', totp: '12345' }).success).toBe(false);
    expect(loginSchema.safeParse({ identifier: 'ali', password: 'x', totp: '123456' }).success).toBe(true);
  });
});

describe('messaging payloads', () => {
  it('defaults type, mentions and attachments safely', () => {
    const parsed = sendMessageSchema.parse({ clientMessageId: 'cmid-12345678', body: 'hello' });
    expect(parsed.type).toBe('text');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.attachmentIds).toEqual([]);
    expect(parsed.encryptionScheme).toBe('none');
  });

  it('refuses oversized bodies and invalid client ids', () => {
    const tooLong = sendMessageSchema.safeParse({ clientMessageId: 'cmid-12345678', body: 'x'.repeat(8001) });
    expect(tooLong.success).toBe(false);
    const badClientId = sendMessageSchema.safeParse({ clientMessageId: 'short', body: 'hi' });
    expect(badClientId.success).toBe(false);
  });

  it('validates post constraints', () => {
    expect(createPostSchema.safeParse({ body: '' }).success).toBe(true); // media-only posts are allowed by the service layer
    expect(createPostSchema.safeParse({ body: 'x'.repeat(4001) }).success).toBe(false);
    expect(createPostSchema.safeParse({ body: 'ok', visibility: 'private' }).success).toBe(false);
  });
});

describe('wire protocol codec', () => {
  it('round-trips frames and reports the version', () => {
    const encoded = encodeFrame({ t: 'hello', protocolVersion: PROTOCOL_VERSION, rid: 'r1' });
    expect(decodeFrame(encoded)).toMatchObject({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('returns null for malformed input instead of throwing', () => {
    expect(decodeFrame('not json')).toBeNull();
    expect(decodeFrame('{"no":"type"}')).toBeNull();
    expect(decodeFrame('[]')).toBeNull();
  });
});
