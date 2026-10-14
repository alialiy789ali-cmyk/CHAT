/**
 * Chooses the cryptographic implementation the Signal-protocol library runs on.
 *
 * **This file is security-critical, and it is imported first for that reason.**
 *
 * The pure-JavaScript Signal implementation reaches all of its primitives through one object — every
 * private key (`Internal.crypto.getRandomBytes`), every AES-CBC operation, every HMAC and every
 * digest. That object is `globalThis.crypto` if it exists, otherwise the library's own bundled
 * implementation. Two consequences follow, and both are decided here rather than left to luck:
 *
 *  1. **Key entropy must come from the platform.** The bundled pure-JS implementation seeds itself
 *     from `Math.random()` when the platform offers no random source — predictable keys, which is the
 *     one failure an E2EE app can never recover from. So a real random source is required, and the
 *     app refuses to start the E2EE layer without one (`expo-crypto` provides the native CSPRNG on
 *     Android and iOS; Node and browsers already have one).
 *
 *  2. **The primitives may be pure JavaScript.** `crypto.subtle` does not exist on React Native, and
 *     the bundled implementation is the library's own documented fallback for exactly that case, so
 *     there is no need for a native crypto module. The symmetric primitives are deterministic given
 *     the keys — the random source above is what has to be strong.
 *
 * The combination handed to `setWebCrypto` is therefore: native randomness + the library's own
 * primitives (or the platform's when it has them, e.g. Node in tests, a browser).
 */
import { setWebCrypto } from '@privacyresearch/libsignal-protocol-typescript';

type RandomSource = { getRandomValues<T extends ArrayBufferView>(array: T): T };
type SubtleLike = SubtleCrypto;

const platform = (globalThis as { crypto?: Partial<RandomSource & { subtle: SubtleLike }> }).crypto;

/**
 * Where the bytes for every private key come from.
 *
 * `expo-crypto` is loaded lazily so the web build and Node tests (which have `globalThis.crypto`)
 * never touch it, and so a missing native module is reported as "no random source" rather than as an
 * import failure.
 */
function randomSource(): { source: string; getRandomValues: RandomSource['getRandomValues'] } | null {
  if (platform && typeof platform.getRandomValues === 'function') {
    return { source: 'platform', getRandomValues: platform.getRandomValues.bind(platform) };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const expoCrypto = require('expo-crypto') as Partial<RandomSource>;
    if (typeof expoCrypto.getRandomValues === 'function') {
      return { source: 'expo-crypto', getRandomValues: expoCrypto.getRandomValues.bind(expoCrypto) };
    }
  } catch {
    // expo-crypto is absent (Node tests, browsers): the platform source above is the one we want.
  }
  return null;
}

/** The AES/HMAC/SHA implementation: the platform's when it exists, the library's own otherwise. */
function subtleSource(): { source: string; subtle: SubtleLike } | null {
  if (platform?.subtle) return { source: 'platform', subtle: platform.subtle as SubtleLike };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundled = require('@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto') as {
      subtle?: SubtleLike;
    };
    if (bundled.subtle) return { source: 'bundled-pure-js', subtle: bundled.subtle };
  } catch {
    // Fall through to the error below: without primitives there is no E2EE at all.
  }
  return null;
}

const random = randomSource();
const subtle = subtleSource();

if (!random || !subtle) {
  throw new Error(
    `e2ee_runtime_unavailable (random: ${random?.source ?? 'none'}, primitives: ${subtle?.source ?? 'none'}) — ` +
      'install expo-crypto (native CSPRNG) or run where crypto.subtle exists',
  );
}

/**
 * A complete WebCrypto-shaped object for the library.
 *
 * Note what is *not* done here: no primitive is implemented in this project. Both parts come from
 * audited implementations — one from the platform, one shipped by the protocol library itself.
 */
setWebCrypto({
  subtle: subtle.subtle,
  getRandomValues: random.getRandomValues,
} as unknown as Crypto);

/** Diagnostics for the settings screen and the logs: where keys and primitives actually come from. */
export const cryptoRuntime = {
  random: random.source,
  primitives: subtle.source,
  /** True when the platform's own WebCrypto is used for both halves (browsers, Node). */
  native: random.source === 'platform' && subtle.source === 'platform',
} as const;

if (!cryptoRuntime.native) {
  // Printed once, on purpose: an operator should be able to see which implementations a device used
  // when a key-verification question comes up.
  console.info(`[e2ee] crypto runtime — randomness: ${cryptoRuntime.random}, primitives: ${cryptoRuntime.primitives}`);
}
