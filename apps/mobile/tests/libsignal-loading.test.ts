/**
 * The other half of the launch-crash demonstration: with the shim installed, the same import works.
 *
 * `libsignal-crash-repro.test.ts` shows the failure under a phone's UTF-8-only decoder. This file lays
 * the same conditions, installs the compatible decoder the way the app entry point does, and imports
 * the very module that used to abort the process — then performs a real X25519 exchange with it, so the
 * proof is "the crypto works", not merely "the import did not throw".
 */
import { describe, expect, it } from 'vitest';
import { installCompatibleTextDecoder } from '../src/lib/text-encoding';

/** The decoder a phone has: UTF-8 only, and the exact message Android logged. */
class Utf8OnlyDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label: string = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const normalized = String(label).trim().toLowerCase();
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(normalized)) {
      throw new RangeError(`Unknown encoding: ${label} (normalized: ${normalized})`);
    }
    this.fatal = Boolean(options.fatal);
    this.ignoreBOM = Boolean(options.ignoreBOM);
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    const bytes = input === undefined ? new Uint8Array(0) : new Uint8Array(input as ArrayBuffer);
    return Buffer.from(bytes).toString('utf8');
  }
}

describe('the crypto library once the decoder is compatible', () => {
  it('imports and performs a real key agreement on the phone’s decoder', async () => {
    const phoneDecoder = Utf8OnlyDecoder as unknown as new (
      label?: string,
      options?: { fatal?: boolean; ignoreBOM?: boolean },
    ) => { encoding: string; fatal: boolean; ignoreBOM: boolean; decode(input?: ArrayBuffer | ArrayBufferView): string };

    // The order the app uses: the platform's decoder is already installed, then the shim goes over it,
    // then — and only then — the crypto library is evaluated.
    Object.defineProperty(globalThis, 'TextDecoder', { value: Utf8OnlyDecoder, configurable: true });
    expect(installCompatibleTextDecoder(phoneDecoder)).toBe(true);
    // Idempotent: a second caller must not wrap the shim in itself.
    expect(installCompatibleTextDecoder(phoneDecoder)).toBe(false);

    const { Curve25519Wrapper } = await import('@privacyresearch/curve25519-typescript');
    const curve = await Curve25519Wrapper.create();

    // The library types its inputs as `ArrayBuffer`; a private key is exactly 32 bytes either way.
    const privateKey = (fill: number): ArrayBuffer => new Uint8Array(32).fill(fill).buffer as ArrayBuffer;

    // Two parties, two key pairs, one shared secret — the operation the protocol depends on.
    const alice = curve.keyPair(privateKey(7));
    const bob = curve.keyPair(privateKey(11));
    const aliceSees = new Uint8Array(curve.sharedSecret(bob.pubKey, alice.privKey));
    const bobSees = new Uint8Array(curve.sharedSecret(alice.pubKey, bob.privKey));

    expect(aliceSees).toEqual(bobSees);
    expect(aliceSees.byteLength).toBe(32);
    expect(aliceSees.some((byte) => byte !== 0)).toBe(true);

    // Different private keys must not produce the same public key, or the exchange above would be a
    // tautology.
    expect(new Uint8Array(alice.pubKey)).not.toEqual(new Uint8Array(bob.pubKey));

    // Signing produces a 64-byte signature, which is the shape the protocol stores with a signed prekey.
    // (`verify` on this wrapper is not asserted here: it returns false for its own signatures in this
    // package on any decoder, including Node's, so it would say nothing about this fix. The signed
    // prekey path is covered where it is used — the E2EE engine tests — and the emulator run is what
    // proves the app itself starts.)
    const signature = curve.sign(alice.privKey, new TextEncoder().encode('sovereign').buffer as ArrayBuffer);
    expect((signature as ArrayBuffer).byteLength).toBe(64);
  });
});
