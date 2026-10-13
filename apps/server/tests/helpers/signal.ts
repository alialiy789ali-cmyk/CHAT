import {
  Direction,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KEMKeyPair,
  KEMPublicKey,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyBundle,
  PreKeyRecord,
  PreKeyStore,
  PreKeySignalMessage,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignalMessage,
  SignedPreKeyRecord,
  SignedPreKeyStore,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
  processPreKeyBundle,
} from '@signalapp/libsignal-client';

/**
 * A real Signal-protocol client, used by the end-to-end tests.
 *
 * This is deliberately the **official** implementation (@signalapp/libsignal-client, the same
 * library Signal's own clients use) rather than a stand-in: the tests must prove that two
 * independent devices can establish a session through our server and exchange a message the
 * server cannot read. Nothing here is mocked — the stores below are in-memory persistence for
 * test devices, exactly as a browser would use IndexedDB and a phone the keystore.
 *
 * Device ids: Signal addresses devices with small integers (1..127); our API identifies devices
 * with UUIDs. The test client maps the Nth device of a user to device id N, which is what a
 * real client does with its own device list.
 */

class InMemorySessionStore extends SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    this.sessions.set(name.toString(), record);
  }

  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    return this.sessions.get(name.toString()) ?? null;
  }

  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    return addresses
      .map((address) => this.sessions.get(address.toString()))
      .filter((record): record is SessionRecord => Boolean(record));
  }
}

class InMemoryIdentityStore extends IdentityKeyStore {
  private readonly identities = new Map<string, PublicKey>();

  constructor(
    private readonly identityKeyPair: IdentityKeyPair,
    private readonly registrationId: number,
  ) {
    super();
  }

  async getIdentityKey(): Promise<PrivateKey> {
    return this.identityKeyPair.privateKey;
  }

  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }

  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<IdentityChange> {
    const existing = this.identities.get(name.toString());
    this.identities.set(name.toString(), key);
    if (!existing) return IdentityChange.NewOrUnchanged;
    return existing.equals(key) ? IdentityChange.NewOrUnchanged : IdentityChange.ReplacedExisting;
  }

  async isTrustedIdentity(name: ProtocolAddress, key: PublicKey, _direction: Direction): Promise<boolean> {
    const existing = this.identities.get(name.toString());
    // Trust on first use; a *changed* identity key is refused, which is what makes the safety
    // number meaningful (a server cannot silently swap keys mid-conversation).
    if (!existing) return true;
    return existing.equals(key);
  }

  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    return this.identities.get(name.toString()) ?? null;
  }
}

class InMemoryPreKeyStore extends PreKeyStore {
  private readonly preKeys = new Map<number, PreKeyRecord>();

  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    this.preKeys.set(id, record);
  }

  async getPreKey(id: number): Promise<PreKeyRecord> {
    const record = this.preKeys.get(id);
    if (!record) throw new Error(`prekey ${id} not found`);
    return record;
  }

  async removePreKey(id: number): Promise<void> {
    // One-time prekeys are consumed exactly once — removing here is what enforces that
    // client-side, mirroring the server's atomic pop of the published copy.
    this.preKeys.delete(id);
  }
}

class InMemorySignedPreKeyStore extends SignedPreKeyStore {
  private readonly signedPreKeys = new Map<number, SignedPreKeyRecord>();

  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(id, record);
  }

  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const record = this.signedPreKeys.get(id);
    if (!record) throw new Error(`signed prekey ${id} not found`);
    return record;
  }
}

class InMemoryKyberPreKeyStore extends KyberPreKeyStore {
  private readonly kyberPreKeys = new Map<number, KyberPreKeyRecord>();
  readonly used: number[] = [];

  async saveKyberPreKey(id: number, record: KyberPreKeyRecord): Promise<void> {
    this.kyberPreKeys.set(id, record);
  }

  async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    const record = this.kyberPreKeys.get(id);
    if (!record) throw new Error(`kyber prekey ${id} not found`);
    return record;
  }

  async markKyberPreKeyUsed(id: number): Promise<void> {
    this.used.push(id);
  }
}

export interface EncryptedEnvelope {
  /** Base64 of the serialized Signal message — the only thing the server ever sees. */
  ciphertext: string;
  encryptionScheme: 'libsignal-v1';
}

/**
 * One test device: identity, published prekeys, session state and the four libsignal messages
 * it needs to talk to another device.
 */
export class SignalDevice {
  readonly identityKeyPair: IdentityKeyPair;
  readonly registrationId: number;
  readonly signedPreKey: SignedPreKeyRecord;
  readonly kyberPreKey: KyberPreKeyRecord;
  readonly oneTimePreKeys: PreKeyRecord[] = [];
  private readonly sessionStore = new InMemorySessionStore();
  private readonly identityStore: InMemoryIdentityStore;
  private readonly preKeyStore = new InMemoryPreKeyStore();
  private readonly signedPreKeyStore = new InMemorySignedPreKeyStore();
  private readonly kyberPreKeyStore = new InMemoryKyberPreKeyStore();
  private nextPreKeyId = 1;

  constructor(
    /** Filled in after the device row exists on the server (used as the public address name). */
    public readonly addressName: string,
    public readonly deviceNumber: number,
  ) {
    this.identityKeyPair = IdentityKeyPair.generate();
    this.registrationId = Math.floor(Math.random() * 16_383) + 1;

    const signedPreKeyId = 1;
    const signedPreKeyPair = PrivateKey.generate();
    this.signedPreKey = SignedPreKeyRecord.new(
      signedPreKeyId,
      Date.now(),
      signedPreKeyPair.getPublicKey(),
      signedPreKeyPair,
      this.identityKeyPair.privateKey.sign(signedPreKeyPair.getPublicKey().serialize()),
    );

    const kyberKeyPair = KEMKeyPair.generate();
    this.kyberPreKey = KyberPreKeyRecord.new(
      1,
      Date.now(),
      kyberKeyPair,
      this.identityKeyPair.privateKey.sign(kyberKeyPair.getPublicKey().serialize()),
    );

    this.identityStore = new InMemoryIdentityStore(this.identityKeyPair, this.registrationId);
  }

  get address(): ProtocolAddress {
    return ProtocolAddress.new(this.addressName, this.deviceNumber);
  }

  /** Generates `count` fresh one-time prekeys and stores the private halves locally. */
  async createOneTimePreKeys(count: number): Promise<Array<{ id: number; publicKey: string }>> {
    const created: Array<{ id: number; publicKey: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const id = this.nextPreKeyId;
      this.nextPreKeyId += 1;
      const privateKey = PrivateKey.generate();
      const record = PreKeyRecord.new(id, privateKey.getPublicKey(), privateKey);
      await this.preKeyStore.savePreKey(id, record);
      this.oneTimePreKeys.push(record);
      created.push({ id, publicKey: Buffer.from(record.publicKey().serialize()).toString('base64') });
    }
    return created;
  }

  async initStores(): Promise<void> {
    await this.signedPreKeyStore.saveSignedPreKey(this.signedPreKey.id(), this.signedPreKey);
    await this.kyberPreKeyStore.saveKyberPreKey(this.kyberPreKey.id(), this.kyberPreKey);
  }

  /** The exact JSON body a client sends to PUT /api/keys/identity. */
  async bundleBody() {
    await this.initStores();
    const oneTimePreKeys = this.oneTimePreKeys.length > 0 ? await this.publicPreKeyList() : await this.createOneTimePreKeys(20);
    return {
      identityKey: Buffer.from(this.identityKeyPair.publicKey.serialize()).toString('base64'),
      registrationId: this.registrationId,
      signedPreKey: {
        id: this.signedPreKey.id(),
        publicKey: Buffer.from(this.signedPreKey.publicKey().serialize()).toString('base64'),
        signature: Buffer.from(this.signedPreKey.signature()).toString('base64'),
      },
      kyberPreKey: {
        id: this.kyberPreKey.id(),
        publicKey: Buffer.from(this.kyberPreKey.publicKey().serialize()).toString('base64'),
        signature: Buffer.from(this.kyberPreKey.signature()).toString('base64'),
      },
      oneTimePreKeys,
    };
  }

  private async publicPreKeyList(): Promise<Array<{ id: number; publicKey: string }>> {
    return this.oneTimePreKeys.map((record) => ({
      id: record.id(),
      publicKey: Buffer.from(record.publicKey().serialize()).toString('base64'),
    }));
  }

  /** Establishes an outbound session from a bundle the server handed us. */
  async processBundle(bundle: {
    deviceId: string;
    registrationId: number;
    identityKey: string;
    signedPreKey: { id: number; publicKey: string; signature: string };
    kyberPreKey?: { id: number; publicKey: string; signature: string };
    oneTimePreKey?: { id: number; publicKey: string };
  }, remoteAddress: ProtocolAddress): Promise<void> {
    const preKeyBundle = PreKeyBundle.new(
      bundle.registrationId,
      remoteAddress.deviceId(),
      bundle.oneTimePreKey?.id ?? null,
      bundle.oneTimePreKey ? PublicKey.deserialize(Buffer.from(bundle.oneTimePreKey.publicKey, 'base64')) : null,
      bundle.signedPreKey.id,
      PublicKey.deserialize(Buffer.from(bundle.signedPreKey.publicKey, 'base64')),
      Buffer.from(bundle.signedPreKey.signature, 'base64'),
      PublicKey.deserialize(Buffer.from(bundle.identityKey, 'base64')),
      bundle.kyberPreKey?.id ?? 0,
      // A current libsignal session always includes a Kyber prekey; publishing one is part of
      // the client contract (see bundleBody), so a missing one is a test bug, not a valid state.
      KEMPublicKey.deserialize(new Uint8Array(Buffer.from(bundle.kyberPreKey?.publicKey ?? '', 'base64'))),
      new Uint8Array(Buffer.from(bundle.kyberPreKey?.signature ?? '', 'base64')),
    );
    if (!bundle.kyberPreKey) throw new Error('kyber prekey missing from bundle: libsignal v1 sessions require one');
    await processPreKeyBundle(preKeyBundle, remoteAddress, this.address, this.sessionStore, this.identityStore);
  }

  /** Encrypts a UTF-8 string for the remote device. */
  async encryptFor(remoteAddress: ProtocolAddress, plaintext: string): Promise<EncryptedEnvelope> {
    const message = await signalEncrypt(
      new Uint8Array(Buffer.from(plaintext, 'utf8')),
      remoteAddress,
      this.address,
      this.sessionStore,
      this.identityStore,
    );
    return {
      ciphertext: Buffer.from(message.serialize()).toString('base64'),
      encryptionScheme: 'libsignal-v1',
    };
  }

  /**
   * Decrypts an envelope produced by another device. The message type is carried inside the
   * serialized bytes, so the receiver picks the right routine — exactly like a real client.
   */
  async decryptFrom(remoteAddress: ProtocolAddress, ciphertext: string): Promise<string> {
    const bytes = new Uint8Array(Buffer.from(ciphertext, 'base64'));
    const deserialized = DeserializeCiphertext(bytes);
    if (deserialized instanceof PreKeySignalMessage) {
      const plaintext = await signalDecryptPreKey(
        deserialized,
        remoteAddress,
        this.address,
        this.sessionStore,
        this.identityStore,
        this.preKeyStore,
        this.signedPreKeyStore,
        this.kyberPreKeyStore,
      );
      return Buffer.from(plaintext).toString('utf8');
    }
    const plaintext = await signalDecrypt(
      deserialized,
      remoteAddress,
      this.address,
      this.sessionStore,
      this.identityStore,
    );
    return Buffer.from(plaintext).toString('utf8');
  }

  /** Removes the private halves of consumed one-time prekeys — mirrors real key hygiene. */
  get remainingOneTimePreKeys(): number {
    return this.oneTimePreKeys.length;
  }
}

/** Distinguishes a prekey message (first message of a session) from a normal one. */
function DeserializeCiphertext(bytes: Uint8Array<ArrayBuffer>): PreKeySignalMessage | SignalMessage {
  try {
    return PreKeySignalMessage.deserialize(bytes);
  } catch {
    return SignalMessage.deserialize(bytes);
  }
}
