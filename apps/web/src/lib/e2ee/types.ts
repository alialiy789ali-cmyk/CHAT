/**
 * Shapes shared by the client-side E2EE modules and the UI.
 *
 * These mirror the server DTOs (`/api/keys/*`, message envelopes) so the browser never has to
 * guess a field name; the server remains the source of truth for validation.
 */

/** A scheme the platform understands. `none` is an unencrypted conversation. */
export type EncryptionScheme = 'none' | 'libsignal-v1' | 'olm-v1';

/** One ciphertext addressed to one device. */
export interface MessageEnvelope {
  deviceId: string;
  scheme: Exclude<EncryptionScheme, 'none'>;
  ciphertext: string;
}

/**
 * What actually travels inside an envelope.
 *
 * Matrix clients carry the same fields: a recipient cannot build an inbound session from a prekey
 * message without the sender's identity key, and it must not have to guess which of the sender's
 * devices wrote it. Both values are public keys, and the receiver re-checks them against the
 * sender's published bundles before use.
 */
export interface OlmEnvelopePayload {
  /** 0 = prekey message (starts a session), 1 = normal message on an existing ratchet. */
  type: number;
  body: string;
  /** Curve25519 identity key of the device that produced this ciphertext. */
  senderIdentityKey: string;
  /** Ed25519 signing key of that device. */
  senderSigningKey: string;
}

/** Parses an envelope body, rejecting anything that is not a well-formed Olm payload. */
export function parseEnvelope(ciphertext: string): OlmEnvelopePayload {
  const parsed = JSON.parse(ciphertext) as Partial<OlmEnvelopePayload>;
  if (typeof parsed.type !== 'number' || typeof parsed.body !== 'string') throw new Error('envelope_malformed');
  return {
    type: parsed.type,
    body: parsed.body,
    senderIdentityKey: parsed.senderIdentityKey ?? '',
    senderSigningKey: parsed.senderSigningKey ?? '',
  };
}

export function serializeEnvelope(payload: OlmEnvelopePayload): string {
  return JSON.stringify(payload);
}

/** A device's public bundle as returned by `GET /api/keys/:userId`. */
export interface E2eeDeviceBundle {
  deviceId: string;
  algorithm: Exclude<EncryptionScheme, 'none'>;
  registrationId: number;
  identityKey: string;
  signingKey?: string;
  identitySignature?: string;
  /** Field name matches the API DTO in `GET /api/keys/:userId`. */
  oneTimePreKey?: { id: string | number; publicKey: string };
}

/** This device's own row in `GET /api/keys/me`. */
export interface OwnDeviceInventory {
  deviceId: string;
  algorithm: Exclude<EncryptionScheme, 'none'>;
  signingKey: string | null;
  remainingOneTimePreKeys: number;
  identityKey: string;
  verifiedAt: string | null;
}

/** Encryption state of a conversation, including who is ready to receive. */
export interface ConversationEncryptionStatus {
  conversationId: string;
  type: string;
  isEncrypted: boolean;
  e2eeEnabled: boolean;
  participants: Array<{
    userId: string;
    role: string;
    devicesWithKeys: number;
    ready: boolean;
    algorithms: Array<Exclude<EncryptionScheme, 'none'>>;
  }>;
  ready: boolean;
}

/** Per-verifier device verification state (`GET /api/keys/verify/:userId`). */
export interface PeerDeviceVerification {
  deviceId: string;
  userId: string;
  verified: boolean;
  fingerprint: string | null;
  verifiedAt: string | null;
  algorithm?: Exclude<EncryptionScheme, 'none'>;
  identityKey?: string | null;
  signingKey?: string | null;
}

/** What one decrypted message looks like to the thread, before it reaches the renderer. */
export interface DecryptedMessage {
  messageId: string;
  body: string;
  /** True when the text was restored from this device's local cache rather than decrypted now. */
  fromCache: boolean;
}

/** The state a bubble can be in when the plaintext is not simply available. */
export type MessageLockState =
  | 'plaintext'
  | 'decrypted'
  | 'locked'          // encrypted, this device has no key/envelope for it
  | 'pending'         // encrypted, still decrypting
  | 'failed';         // decryption failed (tampered, or the session was reset elsewhere)
