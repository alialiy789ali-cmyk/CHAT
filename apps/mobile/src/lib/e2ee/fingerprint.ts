/**
 * Safety numbers on the phone.
 *
 * Deliberately the *same construction* as the web client (see `apps/web/src/lib/e2ee/fingerprint.ts`):
 * SHA-512 over `SOVEREIGN-SAFETY-V1|<identity key A>|<identity key B>` with the keys sorted, rendered
 * as 12 groups of 5 digits, plus a seven-symbol form derived from a second digest. Two devices that
 * use different schemes (Olm in a browser, libsignal on a phone) can therefore still read the same
 * digits to each other — which is the whole point of the ritual.
 *
 * Hashing public keys is not custom cryptography; it is what Signal's own safety number does.
 */
import { fromByteArray, toByteArray } from 'base64-js';

const encoder = new TextEncoder();

export const toBase64 = (buffer: ArrayBuffer | Uint8Array): string =>
  fromByteArray(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

export const fromBase64 = (value: string): ArrayBuffer => {
  const bytes = toByteArray(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const utf8 = (value: string): ArrayBuffer => encoder.encode(value).buffer as ArrayBuffer;
export const fromUtf8 = (buffer: ArrayBuffer): string => new TextDecoder().decode(new Uint8Array(buffer));

async function sha512(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-512', encoder.encode(input) as unknown as BufferSource);
  return new Uint8Array(digest);
}

/** Short, stable fingerprint of one identity key, shown next to a device. */
export async function deviceFingerprint(identityKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(identityKey) as unknown as BufferSource));
  const hex = [...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,4}/g)!.join(' ');
}

/** The 60-digit safety number between two identity keys (order independent). */
export async function safetyNumber(identityKeyA: string, identityKeyB: string): Promise<string[]> {
  const [first, second] = [identityKeyA, identityKeyB].sort();
  const digest = await sha512(`SOVEREIGN-SAFETY-V1|${first}|${second}`);
  let value = 0n;
  for (const byte of digest) value = (value << 8n) | BigInt(byte);
  const digits = (value % 10n ** 60n).toString().padStart(60, '0');
  return digits.match(/.{5}/g)!;
}

/** 64 unambiguous symbols, the same table the web client uses. */
export const SAFETY_EMOJI = [
  '🐶', '🐱', '🦁', '🐎', '🦄', '🐷', '🐘', '🐰',
  '🐼', '🐓', '🐧', '🐢', '🐟', '🐙', '🦋', '🌸',
  '🌲', '🌵', '🍄', '🍓', '🍋', '🍑', '🍆', '🌽',
  '🍕', '🍔', '🍟', '🍦', '🍰', '🍫', '🍿', '🍷',
  '🚗', '🚕', '🚌', '🚓', '🚑', '🚒', '🚲', '✈️',
  '🚀', '🚁', '⛵', '🚂', '🏠', '🏢', '🏥', '🏫',
  '⚽', '🏀', '🎾', '🎲', '🎸', '🎺', '🎻', '🎤',
  '📱', '💻', '📷', '🔑', '🔔', '📚', '✏️', '⭐',
];

/** Seven symbols derived from the same pair of keys. */
export async function safetyNumberEmoji(identityKeyA: string, identityKeyB: string): Promise<string[]> {
  const [first, second] = [identityKeyA, identityKeyB].sort();
  const digest = await sha512(`SOVEREIGN-SAFETY-EMOJI-V1|${first}|${second}`);
  const symbols: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const bitOffset = index * 6;
    let value = 0;
    for (let bit = 0; bit < 6; bit += 1) {
      const position = bitOffset + bit;
      const byte = digest[position >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (position & 7))) & 1);
    }
    symbols.push(SAFETY_EMOJI[value] ?? '⬜');
  }
  return symbols;
}
