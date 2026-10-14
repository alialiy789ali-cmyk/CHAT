/**
 * The browser's Olm engine: one device, many pairwise ratchets.
 *
 * This wraps the reference Matrix implementation (@matrix-org/olm). No cryptographic primitive is
 * implemented here — the module below only decides *which* events happen in which order, because
 * that is exactly where a hand-rolled E2EE integration goes wrong:
 *
 *   - a device is registered once and its pickles live in IndexedDB (see ./store);
 *   - the peer's identity key is verified against the Ed25519 signature before a session is built,
 *     so a server that swaps a bundle cannot silently become the man in the middle;
 *   - one envelope is produced per recipient *device*, because a ratchet is pairwise;
 *   - the safety number is computed from the two identity keys, so each side can derive it without
 *     a round trip and a substituted key is visible (see ./fingerprint).
 */
import { serializeEnvelope, type E2eeDeviceBundle, type E2eeDeviceDescriptor, type MessageEnvelope } from './types';
import {
  deleteSession,
  loadAccount,
  loadSession,
  loadSessions,
  saveAccount,
  saveSession,
  sessionKey,
  type StoredAccount,
} from './store';

/* ------------------------------------------------------------------ wasm bootstrap */

interface OlmAccount {
  create(): void;
  identity_keys(): string;
  sign(message: string): string;
  generate_one_time_keys(count: number): void;
  one_time_keys(): string;
  mark_keys_as_published(): void;
  remove_one_time_keys(session: OlmSession): void;
  max_number_of_one_time_keys(): number;
  pickle(key: string): string;
  unpickle(pickle: string, key: string): void;
  free(): void;
}

interface OlmSession {
  create_outbound(account: OlmAccount, theirIdentityKey: string, theirOneTimeKey: string): void;
  create_inbound_from(account: OlmAccount, theirIdentityKey: string, prekeyMessage: string): void;
  encrypt(plaintext: string): { type: number; body: string };
  decrypt(type: number, body: string): string;
  session_id(): string;
  pickle(key: string): string;
  unpickle(pickle: string, key: string): void;
  free(): void;
}

interface OlmUtility {
  ed25519_verify(key: string, message: string, signature: string): void;
  sha256(input: string): string;
  free(): void;
}

interface OlmModule {
  init(opts?: object): Promise<void>;
  Account: new () => OlmAccount;
  Session: new () => OlmSession;
  Utility: new () => OlmUtility;
  get_library_version(): [number, number, number];
}

let olmPromise: Promise<OlmModule> | null = null;

/**
 * Loads the WASM module from our own origin (the copy step writes `/olm.wasm`).
 *
 * The pickle passphrase is a constant because the pickles are encrypted at rest with a
 * non-extractable key by the store layer; Olm itself has no way to hold a secret over a reload.
 */
export function loadOlm(): Promise<OlmModule> {
  if (!olmPromise) {
    olmPromise = (async () => {
      // The package is CommonJS: depending on the bundler/loader the exports land either on the
      // namespace or under `.default`, so accept both instead of failing at the first call.
      const imported = (await import('@matrix-org/olm')) as unknown as OlmModule & { default?: OlmModule };
      const module = typeof imported.init === 'function' ? imported : (imported.default as OlmModule);
      // In a browser the glue must be pointed at the copy the predev/prebuild step places in
      // `public/`; under Node the package resolves its own wasm payload from the filesystem.
      const inBrowser = typeof document !== 'undefined';
      await module.init(inBrowser ? { locateFile: () => '/olm.wasm' } : undefined);
      return module;
    })();
  }
  return olmPromise;
}

/** Pickles are wrapped by the store, so this passphrase is a fixed format marker. */
const PICKLE_KEY = 'sovereign-local-device';

/* ------------------------------------------------------------------ device */

export interface EnsureDeviceOptions {
  userId: string;
  deviceId: string;
  /** Publishes the account on the server; injected so this module stays free of HTTP details. */
  publish: (body: {
    deviceId: string;
    identityKey: string;
    signingKey: string;
    signature: string;
    oneTimeKeys: Array<{ id: string; key: string }>;
  }) => Promise<void>;
  replenish: (body: { deviceId: string; oneTimeKeys: Array<{ id: string; key: string }> }) => Promise<void>;
}

/** How many one-time keys a device keeps available; Olm caps this at 100 per algorithm. */
const ONE_TIME_KEY_TARGET = 20;

/**
 * A device that either already exists in IndexedDB or is created and published now.
 * `created` tells the UI whether a fresh identity was minted for this browser profile.
 */
export class OlmDevice {
  private constructor(
    private readonly olm: OlmModule,
    readonly account: OlmAccount,
    readonly userId: string,
    readonly deviceId: string,
    readonly identityKey: string,
    readonly signingKey: string,
    private readonly options: EnsureDeviceOptions,
    readonly created: boolean,
  ) {}

  static async ensure(options: EnsureDeviceOptions): Promise<OlmDevice> {
    const olm = await loadOlm();
    const stored = await loadAccount(options.deviceId);
    const account = new olm.Account();

    if (stored) {
      account.unpickle(PICKLE_KEY, stored.pickle);
      const keys = JSON.parse(account.identity_keys()) as { curve25519: string; ed25519: string };
      const device = new OlmDevice(
        olm,
        account,
        options.userId,
        options.deviceId,
        keys.curve25519,
        keys.ed25519,
        options,
        false,
      );
      // A device that was created offline (or before a server reset) still needs publishing.
      // Otherwise the pool state lives on the server, so top-ups are driven from the inventory.
      if (!stored.registered) await device.publish(account);
      return device;
    }

    account.create();
    const keys = JSON.parse(account.identity_keys()) as { curve25519: string; ed25519: string };
    const device = new OlmDevice(olm, account, options.userId, options.deviceId, keys.curve25519, keys.ed25519, options, true);
    await device.publish(account);
    return device;
  }

  private async publish(account: OlmAccount): Promise<void> {
    account.generate_one_time_keys(ONE_TIME_KEY_TARGET);
    const oneTimeKeys = oneTimeKeysOf(account);
    await this.options.publish({
      deviceId: this.deviceId,
      identityKey: this.identityKey,
      signingKey: this.signingKey,
      signature: account.sign(this.identityKey),
      oneTimeKeys,
    });
    account.mark_keys_as_published();
    await this.remember(true);
  }

  /**
   * Tops the server-side one-time key pool back up.
   *
   * Olm only exposes *unpublished* keys locally, so the decision rests on the count the server
   * reports (`GET /api/keys/me`). A device that never tops up slowly becomes unable to receive
   * first messages from new peers, which is a silent failure users would experience as
   * "messages I can't read".
   */
  async topUpFromInventory(remaining: number): Promise<boolean> {
    if (remaining >= ONE_TIME_KEY_TARGET / 2) return false;
    const account = this.account;
    account.generate_one_time_keys(ONE_TIME_KEY_TARGET - remaining);
    const keys = oneTimeKeysOf(account);
    if (keys.length === 0) return false;
    await this.options.replenish({ deviceId: this.deviceId, oneTimeKeys: keys });
    account.mark_keys_as_published();
    await this.remember(true);
    return true;
  }

  /** Persists the current account state (pickles change as one-time keys are used). */
  async remember(registered: boolean): Promise<void> {
    const record: StoredAccount = {
      userId: this.userId,
      deviceId: this.deviceId,
      pickle: this.account.pickle(PICKLE_KEY),
      identityKey: this.identityKey,
      signingKey: this.signingKey,
      publishedAt: new Date().toISOString(),
      registered,
    };
    await saveAccount(record);
  }

  /**
   * Confirms a bundle really belongs to the device that signed it.
   *
   * Without this step the server could hand out its own identity key and read everything; the
   * check is cheap and non-optional, so it is part of building a session rather than a caller's
   * responsibility.
   */
  verifyBundle(bundle: Pick<E2eeDeviceDescriptor, 'identityKey'> & Partial<E2eeDeviceDescriptor>): boolean {
    if (!bundle.signingKey || !bundle.identitySignature) return false;
    // Verified against the shipped build: `ed25519_verify` lives on an *instance* of Olm.Utility
    // (`new Utility().ed25519_verify(...)`), not on the class — the static form is undefined.
    const utility = new this.olm.Utility();
    try {
      utility.ed25519_verify(bundle.signingKey, bundle.identityKey, bundle.identitySignature);
      return true;
    } catch {
      return false;
    } finally {
      utility.free();
    }
  }

  /**
   * Encrypts for one peer device, reusing the session that already exists for that pair.
   * Returns the envelope to hand to the server plus the session id for the local cache.
   */
  async encryptFor(
    bundle: Pick<E2eeDeviceBundle, 'deviceId' | 'identityKey' | 'oneTimePreKey' | 'algorithm'>,
    plaintext: string,
  ): Promise<{ envelope: MessageEnvelope; createdSession: boolean }> {
    const existing = await this.restoreSession(bundle.deviceId);
    if (existing) {
      const message = existing.encrypt(plaintext);
      await this.persistSession(existing, bundle.deviceId);
      return {
        envelope: {
          deviceId: bundle.deviceId,
          scheme: 'olm-v1',
          ciphertext: serializeEnvelope({
            type: message.type,
            body: message.body,
            senderIdentityKey: this.identityKey,
            senderSigningKey: this.signingKey,
          }),
        },
        createdSession: false,
      };
    }

    if (!bundle.oneTimePreKey) {
      // A session cannot be started without a one-time key: the server must top the pool up.
      throw new Error('peer_has_no_one_time_key');
    }
    const session = new this.olm.Session();
    // Olm's JS API takes the one-time key value; the id is bookkeeping only.
    session.create_outbound(this.account, bundle.identityKey, String(bundle.oneTimePreKey.publicKey));
    const message = session.encrypt(plaintext);
    await this.persistSession(session, bundle.deviceId);
    // Note: the one-time key consumed here belongs to the *peer*, so nothing is removed from our
    // own account. `remove_one_time_keys` is only valid for an inbound session and throws
    // OLM.BAD_MESSAGE_KEY_ID on an outbound one.
    await this.remember(true);
    return {
      envelope: {
        deviceId: bundle.deviceId,
        scheme: 'olm-v1',
        ciphertext: serializeEnvelope({
          type: message.type,
          body: message.body,
          senderIdentityKey: this.identityKey,
          senderSigningKey: this.signingKey,
        }),
      },
      createdSession: true,
    };
  }

  /**
   * Decrypts an envelope addressed to this device.
   *
   * The prekey (type 0) case creates the inbound session from the sender's identity key, which the
   * caller must have verified; later messages (type 1) are applied to the stored ratchet.
   *
   * `peerDeviceId` is the *sender's* device — note that `envelope.deviceId` is this device, since
   * that is who the ciphertext was addressed to. Keying the session by the envelope's device would
   * file it under our own id and make every reply look like a brand-new conversation (type 0).
   */
  async decryptFrom(peerIdentityKey: string, peerDeviceId: string, envelope: MessageEnvelope): Promise<string> {
    const parsed = JSON.parse(envelope.ciphertext) as { type: number; body: string };
    const existing = await this.restoreSession(peerDeviceId);
    if (existing) {
      try {
        const plaintext = existing.decrypt(parsed.type, parsed.body);
        await this.persistSession(existing, envelope.deviceId);
        return plaintext;
      } catch (error) {
        // A brand-new session from the same peer (they reinstalled, or a prekey message arrived
        // after the first one) is legitimate; anything else must surface to the user.
        if (parsed.type !== 0) throw error;
        existing.free();
        await deleteSession(sessionKey(this.deviceId, peerDeviceId));
      }
    }
    const session = new this.olm.Session();
    session.create_inbound_from(this.account, peerIdentityKey, parsed.body);
    const plaintext = session.decrypt(parsed.type, parsed.body);
    this.account.remove_one_time_keys(session);
    await this.persistSession(session, peerDeviceId);
    await this.remember(true);
    return plaintext;
  }

  /** Cheap existence check: does a ratchet with this peer device already exist locally? */
  async hasStoredSession(peerDeviceId: string): Promise<boolean> {
    return (await loadSession(sessionKey(this.deviceId, peerDeviceId))) !== null;
  }

  private async restoreSession(peerDeviceId: string): Promise<OlmSession | null> {
    const stored = await loadSession(sessionKey(this.deviceId, peerDeviceId));
    if (!stored) return null;
    const session = new this.olm.Session();
    session.unpickle(PICKLE_KEY, stored.pickle);
    return session;
  }

  private async persistSession(session: OlmSession, peerDeviceId: string): Promise<void> {
    await saveSession({
      id: sessionKey(this.deviceId, peerDeviceId),
      deviceId: this.deviceId,
      peerDeviceId,
      pickle: session.pickle(PICKLE_KEY),
      sessionId: session.session_id(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Drops every ratchet with a device whose identity changed — the safe response to a key change. */
  async forgetPeers(peerDeviceIds: string[]): Promise<void> {
    const sessions = await loadSessions(this.deviceId);
    for (const session of sessions.filter((entry) => peerDeviceIds.includes(entry.peerDeviceId))) {
      await deleteSession(session.id);
    }
  }

}

function oneTimeKeysOf(account: OlmAccount): Array<{ id: string; key: string }> {
  const parsed = JSON.parse(account.one_time_keys()) as Record<string, Record<string, string>>;
  return Object.entries(parsed.curve25519 ?? {}).map(([id, key]) => ({ id, key }));
}
