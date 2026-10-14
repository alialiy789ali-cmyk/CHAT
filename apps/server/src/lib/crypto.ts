import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Small crypto helpers. Only well-known primitives from Node's core are used;
 * no bespoke cryptography is implemented anywhere in this project.
 */

export const sha256Hex = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

export const sha256Base64Url = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('base64url');

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomCode(digits = 6): string {
  let code = '';
  while (code.length < digits) {
    for (const byte of randomBytes(digits)) {
      if (byte < 250 && code.length < digits) code += String(byte % 10);
    }
  }
  return code;
}

export const newId = (): string => randomUUID();

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** ------------------------------------------------------------------ field encryption
 * AES-256-GCM with a random IV per record, used for at-rest secrets such as TOTP
 * seeds and SMTP credentials held in the database. Format: v1.<iv>.<tag>.<ciphertext> (urlsafe base64).
 */
export function encryptField(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptField(payload: string, keyBase64: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('unsupported_ciphertext_format');
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** ------------------------------------------------------------------ opaque cursors
 * Cursors are base64url JSON {c: createdAt, i: id}. They are validated on decode so a
 * malformed cursor produces a 400 instead of a database error.
 */
export function encodeCursor(payload: { c: string; i: string }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { c: string; i: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: string; i?: string };
    if (!parsed.c || !parsed.i) throw new Error('bad_cursor');
    if (Number.isNaN(Date.parse(parsed.c))) throw new Error('bad_cursor_date');
    return { c: parsed.c, i: parsed.i };
  } catch {
    const err = new Error('invalid_cursor') as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'invalid_cursor';
    throw err;
  }
}

/** Sanitises a filename for storage: strips paths, keeps extension, limits length. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 120);
  return cleaned.length ? cleaned : 'file';
}

export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx).toLowerCase();
}

/** Idempotency helper for client_message_id values that are not proper UUIDs. */
export function normaliseClientMessageId(raw: string): string {
  return raw.trim().slice(0, 64);
}
