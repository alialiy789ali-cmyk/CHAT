/**
 * A real Matrix Olm client, used by the end-to-end tests.
 *
 * This is the **reference implementation** (@matrix-org/olm, the library Element and every Matrix
 * client ship) rather than a stand-in — the same way `signal.ts` uses the official Signal library.
 * The tests must prove that two independent devices can establish a double-ratchet session through
 * our server and exchange messages the server cannot read; mocking the ratchet would prove nothing.
 *
 * What this helper deliberately mirrors from a real browser client:
 *   - account creation, one-time keys, and `remove_one_time_keys` bookkeeping;
 *   - `create_outbound` for the first message (type 0, prekey) and `create_inbound_from` to accept it;
 *   - the SAS flow with the *ephemeral* keys from the SAS instances (not the identity keys), which is
 *     the part that decides whether both phones display the same safety number.
 *
 * The difference from the browser: this helper keeps its pickle in memory, while the web client
 * stores the same string in IndexedDB. The crypto payloads are byte-for-byte identical.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package ships as a UMD bundle with a WASM payload; load it through require() so Node and
// the browser resolve the same file.
const require = createRequire(import.meta.url);

export interface OlmExports {
  init: () => Promise<void>;
  get_library_version: () => number[];
  Account: new () => OlmAccount;
  Session: new () => OlmSession;
  SAS: new () => OlmSas;
  Utility: new () => OlmUtility;
}

export interface OlmAccount {
  create: () => void;
  identity_keys: () => string;
  sign: (message: string) => string;
  generate_one_time_keys: (count: number) => void;
  one_time_keys: () => string;
  mark_keys_as_published: () => void;
  remove_one_time_keys: (session: OlmSession) => void;
  max_number_of_one_time_keys: () => number;
  pickle: (key: string) => string;
  unpickle: (pickle: string, key: string) => void;
  free: () => void;
}

export interface OlmSession {
  create_outbound: (account: OlmAccount, theirIdentityKey: string, theirOneTimeKey: string) => void;
  create_inbound_from: (account: OlmAccount, theirIdentityKey: string, prekeyMessage: string) => void;
  encrypt: (plaintext: string) => { type: number; body: string };
  decrypt: (type: number, body: string) => string;
  session_id: () => string;
  pickle: (key: string) => string;
  unpickle: (pickle: string, key: string) => void;
  free: () => void;
}

export interface OlmSas {
  get_pubkey: () => string;
  set_their_key: (key: string) => void;
  generate_bytes: (info: string, length: number) => Uint8Array;
  calculate_mac: (input: string, info: string) => Uint8Array;
  calculate_mac_fixed_base64: (input: string, info: string) => string;
  calculate_mac_long_kdf: (input: string, info: string) => Uint8Array;
  pickle: (key: string) => string;
  free: () => void;
}

export interface OlmUtility {
  ed25519_verify: (key: string, message: string, signature: string) => void;
  sha256: (input: string) => string;
  free: () => void;
}

let olmPromise: Promise<OlmExports> | null = null;

/** Loads the WASM module once per test process (the browser loads it once per tab). */
export function loadOlm(): Promise<OlmExports> {
  if (!olmPromise) {
    olmPromise = (async () => {
      const mod = require('@matrix-org/olm') as OlmExports;
      // The Node build resolves its own WASM payload; browsers pass a locator in the web client.
      await mod.init();
      return mod;
    })();
  }
  return olmPromise;
}

export interface OlmDeviceKeys {
  curve25519: string;
  ed25519: string;
}

export interface PublishedOlmBundle {
  identityKey: string;
  signingKey: string;
  signature: string;
  oneTimeKeys: Array<{ id: string; key: string }>;
}

/**
 * One test device. Private material lives in the pickled account and never leaves this object —
 * exactly the invariant the web client must preserve with its IndexedDB store.
 */
export class OlmDevice {
  private constructor(
    private readonly olm: OlmExports,
    readonly account: OlmAccount,
    /** Device label used in the SAS info string (the server's device id in a real client). */
    readonly label: string,
  ) {}

  static async create(label: string): Promise<OlmDevice> {
    const olm = await loadOlm();
    const account = new olm.Account();
    account.create();
    return new OlmDevice(olm, account, label);
  }

  /** Curve25519 (identity/DH) and Ed25519 (signing) public keys of this device. */
  identityKeys(): OlmDeviceKeys {
    return JSON.parse(this.account.identity_keys()) as OlmDeviceKeys;
  }

  /**
   * One-time keys that have been generated but not published yet.
   *
   * Olm returns them grouped by algorithm (`{ curve25519: { <id>: <key> } }`), not flat — reading
   * the object one level too high is a mistake that only shows up as a server-side 400.
   */
  private unpublishedOneTimeKeys(): Array<{ id: string; key: string }> {
    const parsed = JSON.parse(this.account.one_time_keys()) as Record<string, Record<string, string>>;
    return Object.entries(parsed.curve25519 ?? {}).map(([id, key]) => ({ id, key }));
  }

  /** Builds the publish body: identity key, signing key, signature over the identity key. */
  publish(oneTimeKeyCount = 20): PublishedOlmBundle {
    const keys = this.identityKeys();
    this.account.generate_one_time_keys(oneTimeKeyCount);
    const oneTimeKeys = this.unpublishedOneTimeKeys();
    const bundle: PublishedOlmBundle = {
      identityKey: keys.curve25519,
      signingKey: keys.ed25519,
      // The signing key proves the identity key belongs to the same device: the server stores
      // both, but any client can re-verify this signature independently.
      signature: this.account.sign(keys.curve25519),
      oneTimeKeys,
    };
    this.account.mark_keys_as_published();
    return bundle;
  }

  /** Top-up body for `POST /api/keys/prekeys/olm`. */
  topUp(oneTimeKeyCount: number): Array<{ id: string; key: string }> {
    this.account.generate_one_time_keys(oneTimeKeyCount);
    const keys = this.unpublishedOneTimeKeys();
    this.account.mark_keys_as_published();
    return keys;
  }

  /** Starts a session towards a bundle fetched from the API and encrypts the first message. */
  async encryptFirst(theirIdentityKey: string, theirOneTimeKey: string, plaintext: string) {
    const session = new this.olm.Session();
    session.create_outbound(this.account, theirIdentityKey, theirOneTimeKey);
    const message = session.encrypt(plaintext);
    const encrypted = JSON.stringify({ type: message.type, body: message.body, sessionId: session.session_id() });
    // A device that sends must also be able to receive the reply on the same session.
    this.sessions.set(session.session_id(), session);
    return { session, type: message.type, body: message.body, ciphertext: encrypted };
  }

  /** Encrypts on an established session (type 1 once the handshake completed). */
  encryptOn(session: OlmSession, plaintext: string) {
    const message = session.encrypt(plaintext);
    return { type: message.type, body: message.body, ciphertext: JSON.stringify({ type: message.type, body: message.body }) };
  }

  /** Accepts a prekey message from a new peer and decrypts it. */
  decryptFirst(theirIdentityKey: string, prekeyBody: string, type: number) {
    const session = new this.olm.Session();
    session.create_inbound_from(this.account, theirIdentityKey, prekeyBody);
    const plaintext = session.decrypt(type, prekeyBody);
    // Keys used by this session are no longer available for another inbound session.
    this.account.remove_one_time_keys(session);
    this.sessions.set(session.session_id(), session);
    return { session, plaintext };
  }

  /** Decrypts a later message on an existing session. */
  decryptOn(session: OlmSession, type: number, body: string): string {
    return session.decrypt(type, body);
  }

  /** Looks up a session this device created or accepted earlier. */
  session(sessionId: string): OlmSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Verifies a peer's signature with the shipped utility (no server trust involved). */
  verify(theirSigningKey: string, theirIdentityKey: string, signature: string): boolean {
    const utility = new this.olm.Utility();
    try {
      utility.ed25519_verify(theirSigningKey, theirIdentityKey, signature);
      return true;
    } catch {
      return false;
    } finally {
      utility.free();
    }
  }

  private readonly sessions = new Map<string, OlmSession>();
}

/**
 * The SAS exchange as clients must implement it.
 *
 * Matrix's rule is that both sides feed the *same* info string into `generate_bytes`. The string
 * is assembled from a canonical ordering of the two participants so neither side has to guess a
 * role, and it includes both SAS ephemeral public keys so the value cannot be replayed.
 */
export function sasInfo(input: {
  userA: string;
  deviceA: string;
  pubkeyA: string;
  userB: string;
  deviceB: string;
  pubkeyB: string;
}): string {
  const sideA = `${input.userA}|${input.deviceA}|${input.pubkeyA}`;
  const sideB = `${input.userB}|${input.deviceB}|${input.pubkeyB}`;
  const [first, second] = sideA <= sideB ? [sideA, sideB] : [sideB, sideA];
  return `SOVEREIGN_KEY_VERIFICATION_SAS|${first}|${second}`;
}

/** Runs both halves of a SAS exchange and returns the bytes each side derived. */
export async function sasBytesBothSides(params: {
  userA: string;
  deviceA: string;
  userB: string;
  deviceB: string;
}): Promise<{
  aliceBytes: Uint8Array;
  bobBytes: Uint8Array;
  alice: string;
  bob: string;
  info: string;
  sasA: OlmSas;
  sasB: OlmSas;
}> {
  const olm = await loadOlm();
  const sasA = new olm.SAS();
  const sasB = new olm.SAS();
  const pubkeyA = sasA.get_pubkey();
  const pubkeyB = sasB.get_pubkey();
  // Each side needs the *other* side's ephemeral SAS key — exchanging identity keys here is the
  // classic mistake and produces two different numbers on screen.
  sasA.set_their_key(pubkeyB);
  sasB.set_their_key(pubkeyA);
  const info = sasInfo({
    userA: params.userA,
    deviceA: params.deviceA,
    pubkeyA,
    userB: params.userB,
    deviceB: params.deviceB,
    pubkeyB,
  });
  const aliceBytes = sasA.generate_bytes(info, 12);
  const bobBytes = sasB.generate_bytes(info, 12);
  return {
    aliceBytes,
    bobBytes,
    alice: Buffer.from(aliceBytes).toString('hex'),
    bob: Buffer.from(bobBytes).toString('hex'),
    info,
    sasA,
    sasB,
  };
}

/** Formats 12 SAS bytes the way the UI shows them: six groups of five decimal digits. */
export function safetyNumberFromBytes(bytes: Uint8Array): string[] {
  const groups: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const value = (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!;
    groups.push(String(value % 100_000).padStart(5, '0'));
  }
  return groups;
}

/** File-system path of the package, for diagnostics in test failures. */
export const olmPackagePath = join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/@matrix-org/olm');
