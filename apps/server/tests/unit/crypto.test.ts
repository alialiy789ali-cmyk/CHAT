import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  decodeCursor,
  decryptField,
  encodeCursor,
  encryptField,
  extensionOf,
  normaliseClientMessageId,
  randomToken,
  safeEqual,
  safeFileName,
  sha256Hex,
} from '../../src/lib/crypto.js';
import { signAwsRequest, uriEncode } from '../../src/lib/sigv4.js';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { AppError } from '../../src/lib/errors.js';
import { extractHashtags, extractMentions } from '../../src/services/social.service.js';

/** Unit coverage for the security-relevant primitives and small helpers. */

describe('field encryption (AES-256-GCM)', () => {
  const key = createHash('sha256').update('unit-test-key').digest('base64');

  it('round-trips a value and uses a fresh IV each time', () => {
    const first = encryptField('JBSWY3DPEHPK3PXP', key);
    const second = encryptField('JBSWY3DPEHPK3PXP', key);
    expect(first).not.toEqual(second);
    expect(decryptField(first, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptField(second, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fails closed when the ciphertext is tampered with', () => {
    const payload = encryptField('secret-value', key);
    const parts = payload.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('tampered').toString('base64url')].join('.');
    expect(() => decryptField(tampered, key)).toThrow();
  });

  it('rejects an unsupported format instead of guessing', () => {
    expect(() => decryptField('plaintext', key)).toThrow(/unsupported_ciphertext_format/);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('Sovereign-Unit-Test-1');
    expect(hash.startsWith('scrypt$') || hash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword('Sovereign-Unit-Test-1', hash)).toBe(true);
    expect(await verifyPassword('Sovereign-Unit-Test-2', hash)).toBe(false);
  });

  it('never returns a hash that contains the plaintext', async () => {
    const hash = await hashPassword('Unique-Plaintext-Marker-9');
    expect(hash).not.toContain('Unique-Plaintext-Marker-9');
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$broken')).toBe(false);
  });
});

describe('cursors and tokens', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ c: new Date('2024-05-05T10:00:00.000Z').toISOString(), i: '00000000-0000-0000-0000-000000000001' });
    expect(decodeCursor(cursor)).toEqual({ c: '2024-05-05T10:00:00.000Z', i: '00000000-0000-0000-0000-000000000001' });
  });

  it('throws an AppError-compatible error for a bad cursor', () => {
    try {
      decodeCursor('!!not-base64!!');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('invalid_cursor');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('generates high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken(16)));
    expect(tokens.size).toBe(200);
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('file name sanitation', () => {
  it('strips traversal attempts and control characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFileName('bad\u0000name\u001f.txt')).toBe('badname.txt');
    expect(safeFileName('   ')).toBe('file');
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
    expect(extensionOf('no-extension')).toBe('');
    expect(normaliseClientMessageId('  abc123  ')).toBe('abc123');
  });
});

describe('sigv4 signing', () => {
  it('produces the expected signature for a fixed request', async () => {
    const headers = await signAwsRequest({
      method: 'GET',
      url: 'https://minio.local:9000/sovereign/objects/ab/hash.png',
      payloadHash: 'UNSIGNED-PAYLOAD',
      region: 'us-east-1',
      service: 's3',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2024-01-01T00:00:00.000Z'),
    });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20240101\/us-east-1\/s3\/aws4_request/);
    expect(headers['x-amz-date']).toBe('20240101T000000Z');
    expect(headers.authorization).toContain('SignedHeaders=');
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('encodes URIs per RFC 3986', () => {
    expect(uriEncode('a b/c')).toBe('a%20b%2Fc');
    expect(uriEncode('a b/c', false)).toBe('a%20b/c');
    expect(uriEncode('~-_.')).toBe('~-_.');
  });
});

describe('cache adapter (memory driver)', () => {
  it('honours TTLs, counters and pub/sub', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { a: 1 }, 1);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
    expect(await cache.ttl('k')).toBeLessThanOrEqual(1);

    expect(await cache.incr('counter', 60)).toBe(1);
    expect(await cache.incr('counter', 60)).toBe(2);

    const received: unknown[] = [];
    const unsubscribe = await cache.subscribe('chan', (_channel, payload) => received.push(payload));
    await cache.publish('chan', { hello: 'world' });
    expect(received).toEqual([{ hello: 'world' }]);
    await unsubscribe();
    await cache.publish('chan', { hello: 'again' });
    expect(received).toHaveLength(1);

    await cache.set('short', 'x', 0.05);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await cache.get('short')).toBeNull();
    await cache.close();
  });
});

describe('error taxonomy', () => {
  it('maps database errors to stable client codes', () => {
    expect(AppError.from({ code: '23505', constraint: 'users_email_key' }).code).toBe('email_taken');
    expect(AppError.from({ code: '23505', constraint: 'users_username_key' }).code).toBe('username_taken');
    expect(AppError.from({ code: '23505', constraint: 'channels_slug_key' }).code).toBe('slug_taken');
    expect(AppError.from({ code: '23503' }).code).toBe('not_found');
    expect(AppError.from(new Error('boom')).code).toBe('internal_error');
    expect(new AppError('rate_limited').statusCode).toBe(429);
    expect(new AppError('internal_error', 'secret detail').expose).toBe(false);
  });
});

describe('post parsing', () => {
  it('extracts hashtags and mentions with unicode support', () => {
    expect(extractHashtags('مرحبا #سيادة و #تقنية_2026 plus #dup #dup')).toEqual(['سيادة', 'تقنية_2026', 'dup']);
    expect(extractMentions('cc @alice and @bob_2, not @ab')).toEqual(['alice', 'bob_2']);
  });
});
