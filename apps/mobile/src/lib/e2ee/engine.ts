/**
 * The phone's Signal-protocol client.
 *
 * Why Signal here and Olm in the browser: Olm ships as a WebAssembly module, which Hermes does not
 * run; `@privacyresearch/libsignal-protocol-typescript` is the pure-JavaScript build of the double
 * ratchet + prekey protocol. Neither implementation is invented here — this module only decides
 * *which* events happen in *which* order, and that is exactly where a hand-rolled integration goes
 * wrong, so the decisions are written down where they are taken.
 */
/** Imported for its side effect: it decides which cryptographic implementation runs (see ./runtime). */
import { ensureCryptoRuntime } from './runtime';
import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type KeyPairType,
} from '@privacyresearch/libsignal-protocol-typescript';
import { SignalStore } from './storage';
import { fromBase64, fromUtf8, safetyNumber, safetyNumberEmoji, toBase64, utf8 } from './fingerprint';
import type {
  ClaimedBundle,
  ConversationEncryptionStatus,
  DeviceDescriptor,
  E2eeTransport,
  KeyValueBackend,
  MessageEnvelope,
  SendResult,
} from './types';

/** How many one-time prekeys this phone keeps on the server; the server caps a device at 100. */
const ONE_TIME_KEY_TARGET = 20;
const SIGNED_PREKEY_ID = 1;

const preKeyIds = (start: number, count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => start + index);

/**
 * Protocol address for a peer device.
 *
 * The library models a device as `(name, integer deviceId)`, but our device ids are UUIDs. The address
 * therefore carries the pair inside the name (`<userId>:<deviceId>`) and keeps the numeric slot fixed:
 * the string is unique, stable and readable in logs, which is all the address is used for.
 */
export const addressFor = (userId: string, deviceId: string): SignalProtocolAddress =>
  new SignalProtocolAddress(`${userId}:${deviceId}`, 1);

export interface MobileE2eeOptions {
  userId: string;
  deviceId: string;
  transport: E2eeTransport;
  backend: KeyValueBackend;
}

export class MobileE2eeEngine {
  private constructor(
    private readonly transport: E2eeTransport,
    readonly store: SignalStore,
    readonly userId: string,
    readonly deviceId: string,
  ) {}

  /**
   * Creates the engine for one device.
   *
   * The cryptographic backend is already configured when this module loads (`./runtime`), so all
   * this does is bind a device's key store to its id and make sure the server knows its keys.
   */
  static async create(options: MobileE2eeOptions): Promise<MobileE2eeEngine> {
    /**
     * The crypto runtime is prepared here, not at import time.
     *
     * A device without a usable random source must lose encryption — not the whole application — and
     * the caller (the E2EE provider) turns this failure into a visible state with the reason, so a
     * user sees "encryption is unavailable: …" instead of an app that closes on launch.
     */
    ensureCryptoRuntime();
    const engine = new MobileE2eeEngine(
      options.transport,
      new SignalStore(options.backend, options.deviceId),
      options.userId,
      options.deviceId,
    );
    await engine.ensureKeys();
    return engine;
  }

  /** ---------------------------------------------------------------- provisioning */

  /**
   * Makes sure this device has an identity and a published key set.
   *
   * Runs on every start, so a device that was created offline, or whose upload was interrupted,
   * converges instead of failing at the first message.
   */
  async ensureKeys(): Promise<{ created: boolean; published: boolean; oneTimeKeysRemaining: number }> {
    let identity = await this.store.loadIdentityKeyPair();
    const created = !identity;
    if (!identity) {
      identity = await KeyHelper.generateIdentityKeyPair();
      await this.store.saveIdentityKeyPair(identity);
      await this.store.saveRegistrationId(KeyHelper.generateRegistrationId());
    }

    let signedPreKey = await this.store.loadSignedPreKey(SIGNED_PREKEY_ID);
    let signature = await this.store.getRaw(`signedprekey-signature:${SIGNED_PREKEY_ID}`);
    if (!signedPreKey || !signature) {
      const generated = await KeyHelper.generateSignedPreKey(identity, SIGNED_PREKEY_ID);
      signedPreKey = generated.keyPair;
      signature = toBase64(generated.signature);
      await this.store.storeSignedPreKey(SIGNED_PREKEY_ID, generated.keyPair);
      await this.store.setRaw(`signedprekey-signature:${SIGNED_PREKEY_ID}`, signature);
    }

    /**
     * Which one-time prekeys to upload.
     *
     * A restart re-sends whatever the server never acknowledged, so an install that published while
     * offline converges. A *fresh* install has nothing local and mints its first batch. A returning
     * install with nothing outstanding sends none: republishing an accepted batch would only put
     * keys on the server whose private halves the device has already used, and a claimed key whose
     * private half is gone is a message nobody can read.
     */
    const returning = await this.store.hasPublishedKeys();
    let preKeys = await this.unpublishedPreKeys();
    if (preKeys.length === 0 && !returning) preKeys = await this.generatePreKeys(ONE_TIME_KEY_TARGET);

    await this.publish(identity, signedPreKey, signature, preKeys);

    // The pool drains one key per *new inbound session*, so it is topped up from the count the
    // server reports rather than from local bookkeeping.
    const inventory = await this.inventory().catch(() => null);
    if (inventory && preKeys.length === 0) await this.topUpFromInventory(inventory.remainingOneTimePreKeys);

    return {
      created,
      published: true,
      oneTimeKeysRemaining: inventory?.remainingOneTimePreKeys ?? preKeys.length,
    };
  }

  private async generatePreKeys(count: number): Promise<Array<{ id: number; publicKey: string }>> {
    const existing = await this.store.localPreKeyIds();
    const start = existing.length > 0 ? existing[existing.length - 1]! + 1 : 1;
    const created: Array<{ id: number; publicKey: string }> = [];
    for (const id of preKeyIds(start, count)) {
      const generated = await KeyHelper.generatePreKey(id);
      await this.store.storePreKey(id, generated.keyPair);
      created.push({ id, publicKey: toBase64(generated.keyPair.pubKey) });
    }
    return created;
  }

  /** Prekeys generated locally that the server has not been told about yet. */
  private async unpublishedPreKeys(): Promise<Array<{ id: number; publicKey: string }>> {
    const result: Array<{ id: number; publicKey: string }> = [];
    for (const id of await this.store.unpublishedPreKeyIds()) {
      const pair = await this.store.loadPreKey(id);
      if (pair) result.push({ id, publicKey: toBase64(pair.pubKey) });
    }
    return result;
  }

  private async publish(
    identity: KeyPairType,
    signedPreKey: KeyPairType,
    signature: string,
    preKeys: Array<{ id: number; publicKey: string }>,
  ): Promise<void> {
    await this.transport.put('/api/keys/identity', {
      deviceId: this.deviceId,
      identityKey: toBase64(identity.pubKey),
      registrationId: (await this.store.getLocalRegistrationId()) ?? 1,
      signedPreKey: { id: SIGNED_PREKEY_ID, publicKey: toBase64(signedPreKey.pubKey), signature },
      oneTimePreKeys: preKeys.map((entry) => ({ id: entry.id, publicKey: entry.publicKey })),
    });
    // Marked only after the server answered, so a failed upload is retried on the next start.
    await this.store.markPublishedPreKeys(preKeys.map((entry) => entry.id));
  }

  async inventory(): Promise<{ deviceId: string; algorithm: string; remainingOneTimePreKeys: number }> {
    const result = await this.transport.get<{
      devices: Array<{ deviceId: string; algorithm: string; remainingOneTimePreKeys: number }>;
    }>('/api/keys/me');
    return (
      result.devices.find((device) => device.deviceId === this.deviceId) ?? {
        deviceId: this.deviceId,
        algorithm: 'none',
        remainingOneTimePreKeys: 0,
      }
    );
  }

  /**
   * Tops the server-side pool up when it runs low.
   *
   * A device that never tops up slowly becomes unable to receive *first* messages from new peers — a
   * failure users experience as "messages I can't read", with nothing in the UI to explain it.
   */
  async topUpFromInventory(remaining: number): Promise<boolean> {
    if (remaining >= ONE_TIME_KEY_TARGET / 2) return false;
    const generated = await this.generatePreKeys(ONE_TIME_KEY_TARGET - remaining);
    if (generated.length === 0) return false;
    await this.transport.post('/api/keys/prekeys', {
      deviceId: this.deviceId,
      oneTimePreKeys: generated.map((entry) => ({ id: entry.id, publicKey: entry.publicKey })),
    });
    await this.store.markPublishedPreKeys(generated.map((entry) => entry.id));
    return true;
  }

  async identityKey(): Promise<string> {
    const identity = await this.store.loadIdentityKeyPair();
    if (!identity) throw new Error('identity_missing');
    return toBase64(identity.pubKey);
  }

  /** ---------------------------------------------------------------- peers */

  /** Who has keys right now. Free of side effects, so it is safe before every send. */
  async directory(userId: string): Promise<DeviceDescriptor[]> {
    const result = await this.transport.get<{ devices: DeviceDescriptor[] }>(`/api/keys/${userId}/devices`);
    return result.devices;
  }

  /** Claims one one-time prekey per device. Destructive: only for devices without a session. */
  async claim(userId: string): Promise<ClaimedBundle[]> {
    const result = await this.transport.get<{ bundles: ClaimedBundle[] }>(`/api/keys/${userId}`);
    return result.bundles;
  }

  /**
   * Whether a ratchet with that peer device already exists.
   *
   * The address has to be built from the *peer's* user id, because that is the string the library
   * itself uses as the session's storage key (`remoteAddress.toString()`). Using this device's own id
   * here would look up a key nobody ever wrote: every send would claim a fresh one-time prekey, and
   * every send would fail as "no session".
   */
  async hasSession(peerUserId: string, peerDeviceId: string): Promise<boolean> {
    return (await this.store.loadSession(addressFor(peerUserId, peerDeviceId).toString())) !== undefined;
  }

  /** Builds the session from a claimed bundle; the protocol verifies the signed prekey here. */
  async buildSession(input: { peerUserId: string; bundle: ClaimedBundle }): Promise<void> {
    const { bundle } = input;
    if (!bundle.signedPreKey) throw new Error('bundle_without_signed_prekey');
    await new SessionBuilder(this.store, addressFor(input.peerUserId, bundle.deviceId)).processPreKey({
      identityKey: fromBase64(bundle.identityKey),
      signedPreKey: {
        keyId: Number(bundle.signedPreKey.id),
        publicKey: fromBase64(bundle.signedPreKey.publicKey),
        signature: fromBase64(bundle.signedPreKey.signature),
      },
      preKey: bundle.oneTimePreKey
        ? { keyId: Number(bundle.oneTimePreKey.id), publicKey: fromBase64(bundle.oneTimePreKey.publicKey) }
        : undefined,
      registrationId: bundle.registrationId,
    });
  }

  /** ---------------------------------------------------------------- sending */

  /**
   * Encrypts one plaintext for every device of every participant that speaks this client's scheme.
   *
   * The outcomes are reported separately because they call for different reactions: a user with
   * nothing addressable blocks the send, one dead device only warns, and a device on the other scheme
   * (a browser) is a limitation to state honestly rather than to hide behind a "delivered" tick.
   */
  async encryptForConversation(
    conversation: ConversationEncryptionStatus,
    plaintext: string,
    skipDeviceId: string | null = this.deviceId,
  ): Promise<SendResult> {
    const envelopes: MessageEnvelope[] = [];
    const skipped: SendResult['skipped'] = [];
    const unreachable: SendResult['unreachable'] = [];
    const schemeMismatches: SendResult['schemeMismatches'] = [];
    const targets = [...new Set(conversation.participants.map((participant) => participant.userId))];

    for (const userId of targets) {
      let directory: DeviceDescriptor[] = [];
      try {
        directory = await this.directory(userId);
      } catch (error) {
        skipped.push({ userId, reason: error instanceof Error ? error.message : 'directory_unavailable' });
        continue;
      }

      const ownScheme = directory.filter((device) => device.algorithm === 'libsignal-v1');
      for (const device of directory) {
        if (device.algorithm !== 'libsignal-v1') {
          schemeMismatches.push({ userId, deviceId: device.deviceId, algorithm: device.algorithm });
        }
      }
      if (directory.length === 0) {
        skipped.push({ userId, reason: 'no_usable_devices' });
        continue;
      }
      if (ownScheme.length === 0) continue; // only devices of the other scheme: the mismatch says it.

      /**
       * Establish a ratchet only where one does not exist.
       *
       * Claiming is destructive — the server hands out one key and forgets it — so a device that
       * already has a session must never have a one-time prekey spent on it. In a group, that is the
       * difference between a stable conversation and one that quietly burns the pool of every member
       * on every message.
       */
      const ready = new Set<string>();
      for (const device of ownScheme) {
        if (device.deviceId === skipDeviceId) continue;
        if (await this.hasSession(userId, device.deviceId)) ready.add(device.deviceId);
      }
      const needsSession = ownScheme
        .map((device) => device.deviceId)
        .filter((deviceId) => deviceId !== skipDeviceId && !ready.has(deviceId));
      if (needsSession.length > 0) {
        try {
          for (const bundle of await this.claim(userId)) {
            if (bundle.algorithm !== 'libsignal-v1' || !needsSession.includes(bundle.deviceId)) continue;
            try {
              await this.buildSession({ peerUserId: userId, bundle });
              ready.add(bundle.deviceId);
            } catch (error) {
              // Reported as unreachable below; the detail stays in the log, the user gets one reason.
              console.warn('[e2ee] could not build a session with device', bundle.deviceId, error);
            }
          }
        } catch (error) {
          // Non-fatal: devices that already have a session still get the message.
          console.warn('[e2ee] could not claim prekeys for', userId, error);
        }
      }

      let addressed = 0;
      let failed = 0;
      for (const device of ownScheme) {
        if (device.deviceId === skipDeviceId) {
          addressed += 1; // this phone holds its own plaintext; no envelope needed
          continue;
        }
        try {
          if (!ready.has(device.deviceId)) throw new Error('session_unavailable');
          const message = await new SessionCipher(this.store, addressFor(userId, device.deviceId)).encrypt(
            utf8(plaintext),
          );
          envelopes.push({
            deviceId: device.deviceId,
            scheme: 'libsignal-v1',
            ciphertext: JSON.stringify({
              type: message.type,
              body: message.body,
              senderDeviceId: this.deviceId,
              senderIdentityKey: await this.identityKey(),
            }),
          });
          addressed += 1;
        } catch (error) {
          failed += 1;
          console.warn('[e2ee] encrypt failed for device', device.deviceId, error);
          unreachable.push({
            userId,
            deviceId: device.deviceId,
            reason: error instanceof Error ? error.message : 'encrypt_failed',
          });
        }
      }

      /**
       * A user whose every device failed is *not* merely "unreachable": nothing was produced for
       * them, so the caller must refuse the send. Reporting it as one dead device would send a
       * message that member can never read while the UI shows a delivered tick.
       */
      if (addressed === 0 && failed > 0) {
        skipped.push({ userId, reason: 'encrypt_failed_for_all_devices' });
        for (let index = unreachable.length - 1; index >= 0; index -= 1) {
          if (unreachable[index]!.userId === userId) unreachable.splice(index, 1);
        }
      }
    }

    return { envelopes, skipped, unreachable, schemeMismatches };
  }

  /** ---------------------------------------------------------------- receiving */

  /**
   * Decrypts an envelope addressed to this device.
   *
   * The claimed sender device is checked against the directory before the ciphertext is opened: a
   * payload may say anything, so the identity key it carries must belong to the device it names. The
   * ratchet then rejects a body that was not produced by that key (libsignal verifies the MAC).
   */
  async decryptEnvelope(input: { senderUserId: string; envelope: MessageEnvelope }): Promise<string> {
    const payload = JSON.parse(input.envelope.ciphertext) as {
      type: number;
      body: string;
      senderDeviceId?: string;
      senderIdentityKey?: string;
    };
    if (!payload.senderDeviceId) throw new Error('envelope_missing_sender_device');

    const sender = (await this.directory(input.senderUserId)).find(
      (device) => device.deviceId === payload.senderDeviceId,
    );
    if (!sender) throw new Error('envelope_sender_device_unknown');
    if (payload.senderIdentityKey && sender.identityKey !== payload.senderIdentityKey) {
      throw new Error('envelope_sender_key_mismatch');
    }

    const cipher = new SessionCipher(this.store, addressFor(input.senderUserId, payload.senderDeviceId));
    const buffer =
      payload.type === 3
        ? await cipher.decryptPreKeyWhisperMessage(payload.body, 'binary')
        : await cipher.decryptWhisperMessage(payload.body, 'binary');
    return fromUtf8(buffer);
  }

  /** ---------------------------------------------------------------- verification */

  /** The 60-digit safety number with a peer identity key — the same digits the web client shows. */
  async safetyNumberWith(peerIdentityKey: string): Promise<string[]> {
    return safetyNumber(await this.identityKey(), peerIdentityKey);
  }

  async safetyEmojiWith(peerIdentityKey: string): Promise<string[]> {
    return safetyNumberEmoji(await this.identityKey(), peerIdentityKey);
  }
}
