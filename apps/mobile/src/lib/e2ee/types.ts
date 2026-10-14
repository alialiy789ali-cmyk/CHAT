/**
 * Shared vocabulary for the mobile E2EE layer.
 *
 * The phone speaks the *Signal* scheme (`libsignal-v1`) while browsers speak Matrix Olm
 * (`olm-v1`): both are proven implementations, and each was chosen for what actually runs on the
 * platform — Olm is a WebAssembly module (browsers only), libsignal has a pure-JavaScript
 * implementation that works under Hermes. The server treats them as two audited schemes and stores
 * one envelope per recipient device, so a conversation can carry both. A device can only *produce*
 * envelopes for the scheme it implements, which is why the engine reports devices of other schemes
 * instead of pretending to cover them (see `schemeMismatches`).
 */

/** Transport the engine needs. The app passes its ApiClient; tests pass a fetch-backed one. */
export interface E2eeTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
}

/**
 * Key/value storage for protocol state.
 *
 * Values are strings on purpose: React Native's keychain-backed stores (expo-secure-store) keep
 * strings, and the protocol state is already base64 (session records are base64 strings, key pairs
 * are base64 fields). One entry per key keeps every item well under the ~2 KB per-item limit that
 * secure stores impose, instead of packing a whole key store into a single blob.
 */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** All keys with the given prefix — used to export/wipe one device's material. */
  keys(prefix: string): Promise<string[]>;
}

export type MobileScheme = 'libsignal-v1';

/** One device of a user, as the directory reports it (`GET /api/keys/:userId/devices`). */
export interface DeviceDescriptor {
  deviceId: string;
  algorithm: string;
  identityKey: string;
  signingKey?: string;
  identitySignature?: string;
}

/** A claimable bundle (`GET /api/keys/:userId`) — carries one one-time prekey for Signal. */
export interface ClaimedBundle extends DeviceDescriptor {
  registrationId: number;
  signedPreKey?: { id: string | number; publicKey: string; signature: string };
  kyberPreKey?: { id: string | number; publicKey: string; signature: string };
  oneTimePreKey?: { id: string | number; publicKey: string };
}

export interface ConversationEncryptionStatus {
  isEncrypted: boolean;
  ready: boolean;
  participants: Array<{ userId: string; ready: boolean; devicesWithKeys: number }>;
}

export interface MessageEnvelope {
  deviceId: string;
  scheme: string;
  ciphertext: string;
}

/** What the engine hands back for one send, mirroring the web client's contract. */
export interface SendResult {
  envelopes: MessageEnvelope[];
  /** Users with nothing addressable — the caller must refuse the send. */
  skipped: Array<{ userId: string; reason: string }>;
  /** One dead device of a reachable user: send anyway, but tell the user. */
  unreachable: Array<{ userId: string; deviceId: string; reason: string }>;
  /** Devices reachable by chat, but not by *this* device's scheme. */
  schemeMismatches: Array<{ userId: string; deviceId: string; algorithm: string }>;
}
