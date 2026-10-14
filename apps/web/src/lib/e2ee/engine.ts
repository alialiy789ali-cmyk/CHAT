/**
 * The bridge between the Olm engine and this platform's API.
 *
 * Everything that touches the network lives here so the crypto module stays independent of HTTP,
 * and every trust decision is made in one place:
 *
 *   - a peer bundle is rejected unless its Ed25519 signature verifies (a server that swaps keys
 *     cannot pass this);
 *   - an incoming payload's claimed sender identity key must appear among the sender's published
 *     devices, so an envelope cannot impersonate somebody else's device;
 *   - decrypted plaintext is cached locally, which is what lets a thread render while offline and
 *     after a reload — the server never receives it.
 */
import { api, type ApiClient } from '@/lib/api';
import { OlmDevice } from './client';
import { cachePlaintext, loadPlaintext, e2eeStorageAvailable, type CachedPlaintext } from './store';
import { parseEnvelope, type ConversationEncryptionStatus, type E2eeDeviceBundle, type MessageEnvelope, type OwnDeviceInventory, type PeerDeviceVerification } from './types';

/** Everything the UI needs to describe this device's encryption state honestly. */
export interface E2eeStatus {
  available: boolean;
  ready: boolean;
  deviceId: string | null;
  identityKey: string | null;
  signingKey: string | null;
  /** True when this browser created the identity in this session (a fresh device). */
  created: boolean;
  oneTimeKeysRemaining: number;
  /** Set when setup failed, so the UI can explain instead of showing a silent lock. */
  error: string | null;
}

export class E2eeEngine {
  private constructor(
    readonly userId: string,
    readonly deviceId: string,
    private readonly device: OlmDevice,
    public created: boolean,
    /** The session this engine speaks through; the browser passes the shared singleton. */
    private readonly client: ApiClient,
  ) {}

  private bundleCache = new Map<string, { bundles: E2eeDeviceBundle[]; at: number }>();
  private static readonly BUNDLE_TTL_MS = 30_000;

  /**
   * Loads (or creates) this browser's device and makes sure the server knows its keys.
   * A failure here is reported, never swallowed: the UI must not claim E2EE without a device.
   */
  static async create(userId: string, deviceId: string, client: ApiClient = api): Promise<E2eeEngine> {
    if (!e2eeStorageAvailable()) throw new Error('e2ee_unsupported_browser');
    // Each device has its own key store, so two engines in one process stay independent only if
    // their storage is separated. The device id is part of every key, which is what makes that work.
    const device = await OlmDevice.ensure({
      userId,
      deviceId,
      publish: async (body) => {
        await client.put('/api/keys/identity/olm', body);
      },
      replenish: async (body) => {
        await client.post('/api/keys/prekeys/olm', body);
      },
    });
    const engine = new E2eeEngine(userId, deviceId, device, device.created, client);
    await engine.refreshInventory();
    return engine;
  }

  get identityKey(): string {
    return this.device.identityKey;
  }

  get signingKey(): string {
    return this.device.signingKey;
  }

  private inventory: OwnDeviceInventory[] = [];

  /**
   * Reads this account's device inventory and tops the one-time key pool up when it runs low.
   * The pool drains one key per new inbound session, so this is what keeps a device reachable.
   */
  async refreshInventory(): Promise<OwnDeviceInventory[]> {
    const result = await this.client.get<{ devices: OwnDeviceInventory[] }>('/api/keys/me');
    this.inventory = result.devices;
    const mine = result.devices.find((entry) => entry.deviceId === this.deviceId);
    if (mine) await this.device.topUpFromInventory(mine.remainingOneTimePreKeys);
    return this.inventory;
  }

  remainingOneTimeKeys(): number {
    return this.inventory.find((entry) => entry.deviceId === this.deviceId)?.remainingOneTimePreKeys ?? 0;
  }

  status(): E2eeStatus {
    return {
      available: true,
      ready: true,
      deviceId: this.deviceId,
      identityKey: this.device.identityKey,
      signingKey: this.device.signingKey,
      created: this.created,
      oneTimeKeysRemaining: this.remainingOneTimeKeys(),
      error: null,
    };
  }

  /**
   * Public bundles for a user, with each device's signature checked.
   * Devices whose signature does not verify are dropped rather than used — a substituted key must
   * never become a session.
   */
  async bundlesFor(userId: string, options: { fresh?: boolean } = {}): Promise<E2eeDeviceBundle[]> {
    const cached = this.bundleCache.get(userId);
    if (!options.fresh && cached && Date.now() - cached.at < E2eeEngine.BUNDLE_TTL_MS) return cached.bundles;

    const result = await this.client.get<{ bundles: E2eeDeviceBundle[] }>(`/api/keys/${userId}`);
    const usable: E2eeDeviceBundle[] = [];
    for (const bundle of result.bundles) {
      if (bundle.algorithm !== 'olm-v1') continue;
      if (!this.device.verifyBundle(bundle)) {
        console.warn('dropped a device bundle with an invalid signature', bundle.deviceId);
        continue;
      }
      usable.push(bundle);
    }
    this.bundleCache.set(userId, { bundles: usable, at: Date.now() });
    return usable;
  }

  /** Drops cached bundles, e.g. after a device list change or a verification. */
  invalidateBundles(userId?: string): void {
    if (userId) this.bundleCache.delete(userId);
    else this.bundleCache.clear();
  }

  /**
   * Encryption status of a conversation (members + readiness). Used both before sending and to
   * decide whether an encryption toggle can be offered at all.
   */
  async conversationStatus(conversationId: string): Promise<ConversationEncryptionStatus> {
    return this.client.get<ConversationEncryptionStatus>(`/api/conversations/${conversationId}/encryption`);
  }

  /**
   * Switches a conversation between encrypted and unencrypted.
   *
   * The server refuses to enable encryption while some member has no keys — better a clear error
   * than a conversation where half the messages are unreadable.
   */
  async setConversationEncryption(conversationId: string, enabled: boolean): Promise<void> {
    await this.client.post(`/api/conversations/${conversationId}/encryption`, { enabled });
    // Readiness and one-time key counts may have changed with the toggle.
    this.invalidateBundles();
    await this.refreshInventory();
  }

  /**
   * Encrypts one plaintext for every device of every participant.
   *
   * `skipDeviceId` is this browser's own device: the sender holds the plaintext locally, so
   * spending a ratchet on itself would only add ciphertext nobody needs.
   * Returns the envelopes plus the devices that could not be encrypted for, so the UI can refuse
   * to send a message that some members would be unable to read.
   */
  async encryptForConversation(
    conversation: ConversationEncryptionStatus,
    plaintext: string,
    skipDeviceId: string | null = this.deviceId,
  ): Promise<{ envelopes: MessageEnvelope[]; skipped: Array<{ userId: string; reason: string }> }> {
    const envelopes: MessageEnvelope[] = [];
    const skipped: Array<{ userId: string; reason: string }> = [];
    const targets = [...new Set(conversation.participants.map((participant) => participant.userId))];

    for (const userId of targets) {
      let bundles: E2eeDeviceBundle[] = [];
      try {
        bundles = await this.bundlesFor(userId);
      } catch (error) {
        skipped.push({ userId, reason: error instanceof Error ? error.message : 'bundle_unavailable' });
        continue;
      }
      if (bundles.length === 0) {
        skipped.push({ userId, reason: 'no_usable_devices' });
        continue;
      }
      for (const bundle of bundles) {
        if (bundle.deviceId === skipDeviceId) continue;
        try {
          const { envelope } = await this.device.encryptFor(bundle, plaintext);
          envelopes.push(envelope);
        } catch (error) {
          // The usual cause is an exhausted one-time key pool; the caller decides whether that is
          // fatal for this send (it is: that member would not be able to read the message).
          console.warn('[e2ee] encrypt failed for device', bundle.deviceId, error);
          skipped.push({ userId, reason: error instanceof Error ? error.message : 'encrypt_failed' });
        }
      }
    }
    return { envelopes, skipped };
  }

  /** Decrypts an envelope for this device and remembers the plaintext locally. */
  async decryptEnvelope(input: {
    messageId: string;
    conversationId: string;
    senderUserId: string;
    envelope: MessageEnvelope;
    mine: boolean;
  }): Promise<string> {
    const cached = await loadPlaintext(input.messageId);
    if (cached) return cached.body;

    const payload = parseEnvelope(input.envelope.ciphertext);
    if (!payload.senderIdentityKey) throw new Error('envelope_missing_sender_key');

    // Bind the claimed sender key to the sender's published devices before starting a session.
    const bundles = await this.bundlesFor(input.senderUserId).catch(() => [] as E2eeDeviceBundle[]);
    const known = bundles.some((bundle) => bundle.identityKey === payload.senderIdentityKey);
    if (!known) throw new Error('envelope_sender_key_untrusted');

    const plaintext = await this.device.decryptFrom(payload.senderIdentityKey, input.envelope);
    const record: CachedPlaintext = {
      messageId: input.messageId,
      conversationId: input.conversationId,
      deviceId: this.deviceId,
      body: plaintext,
      mine: input.mine,
      storedAt: new Date().toISOString(),
    };
    await cachePlaintext(record);
    return plaintext;
  }

  /** Remembers the plaintext of a message this device just sent. */
  async rememberSent(input: { messageId: string; conversationId: string; body: string }): Promise<void> {
    await cachePlaintext({
      messageId: input.messageId,
      conversationId: input.conversationId,
      deviceId: this.deviceId,
      body: input.body,
      mine: true,
      storedAt: new Date().toISOString(),
    });
  }

  /** Fetches this device's envelope for one message (real-time frames carry none). */
  async fetchEnvelope(messageId: string): Promise<MessageEnvelope | null> {
    const result = await this.client.get<{ envelope: MessageEnvelope | null }>(`/api/messages/${messageId}/envelope`);
    return result.envelope;
  }

  /** Per-device verification state of a peer, as recorded by *this* user. */
  async verificationsFor(userId: string): Promise<PeerDeviceVerification[]> {
    const result = await this.client.get<{ devices: PeerDeviceVerification[] }>(`/api/keys/verify/${userId}`);
    return result.devices;
  }

  /** Records the outcome of a safety-number comparison for one device. */
  async markVerified(deviceId: string, fingerprint: string, verified: boolean): Promise<void> {
    await this.client.post('/api/keys/verify', { deviceId, fingerprint, verified });
  }

  /**
   * Derives the safety number for a peer device.
   *
   * Both sides create a SAS instance, exchange the ephemeral keys it exposes and feed the same
   * canonical info string into `generate_bytes`. The exchange needs a signalling channel; this
   * method covers the half that can be computed here (the peer's ephemeral key must arrive from
   * the verification exchange, see `sasBytes`).
   */
  peers: Array<{ deviceId: string; identityKey: string }> = [];

  /** All devices of a peer, for the verification screen. */
  async peerDevices(userId: string): Promise<E2eeDeviceBundle[]> {
    return this.bundlesFor(userId);
  }

  /** Forgets every ratchet with the given peer devices (used when their identity changes). */
  async forgetPeers(peerDeviceIds: string[]): Promise<void> {
    await this.device.forgetPeers(peerDeviceIds);
  }
}
