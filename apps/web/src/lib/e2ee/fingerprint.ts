/**
 * Safety numbers and device fingerprints.
 *
 * A safety number is what a user compares out loud ("four one two ... three seven") to prove that
 * the keys they are talking to are the peer's and not the server's. Two properties matter:
 *
 *  - **Both sides can compute it independently.** No extra protocol round trip and no key exchange
 *    is needed, because it is derived from the two public identity keys — which is exactly how
 *    Signal's own numeric safety number works. If a server substituted a key, the two numbers
 *    differ and the comparison fails.
 *  - **It is deterministic and order-independent.** The two keys are sorted before hashing, so it
 *    does not matter who looks first.
 *
 * The digest is SHA-512 from the platform's WebCrypto implementation; the digits are a
 * straightforward base-10 rendering of the digest, kept compatible between our own clients (the
 * number is a shared convention inside this platform, not an interop format with Signal clients).
 */

const decoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha512(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-512', decoder.encode(input) as unknown as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Fingerprint of one device's identity key: short, human-readable, and stable.
 * Shown next to a device in the verification list so a user can spot a key that changed.
 */
export async function deviceFingerprint(identityKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(identityKey) as unknown as BufferSource));
  const hex = [...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,4}/g)!.join(' ');
}

/**
 * The 60-digit safety number between two devices.
 *
 * Encoding: take the SHA-512 digest of `SOVEREIGN-SAFETY-V1|keyA|keyB` (keys sorted), read it as a
 * big integer, and render it modulo 10^60 — 12 groups of 5 digits. Every client of this platform
 * computes the same value for the same pair of keys, and any change in either key changes all of
 * the digits.
 */
export async function safetyNumber(identityKeyA: string, identityKeyB: string): Promise<string[]> {
  const [first, second] = [identityKeyA, identityKeyB].sort();
  const digest = await sha512(`SOVEREIGN-SAFETY-V1|${first}|${second}`);
  let value = 0n;
  for (const byte of digest) value = (value << 8n) | BigInt(byte);
  const modulus = 10n ** 60n;
  const digits = (value % modulus).toString().padStart(60, '0');
  return digits.match(/.{5}/g)!;
}

/**
 * A compact visual form of the same number: seven symbols from a fixed table, useful when reading
 * 60 digits aloud is impractical. Derived from the same digest, so it changes together with it.
 */
export async function safetyNumberEmoji(identityKeyA: string, identityKeyB: string): Promise<string[]> {
  const [first, second] = [identityKeyA, identityKeyB].sort();
  const digest = await sha512(`SOVEREIGN-SAFETY-EMOJI-V1|${first}|${second}`);
  const symbols: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    // 6 bits per symbol, read from the digest as a bit stream.
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

/** 64 distinct, unambiguous symbols — the same size table Matrix uses for its emoji comparison. */
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
