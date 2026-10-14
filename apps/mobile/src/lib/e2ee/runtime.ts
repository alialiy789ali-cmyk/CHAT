/**
 * Chooses the cryptographic implementation the Signal-protocol library runs on.
 *
 * **This file is security-critical.** It resolves the runtime on first use (`ensureCryptoRuntime`).
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
/**
 * First, and before the line below: the Signal-protocol library pulls in an emscripten-built curve25519
 * whose module scope constructs `new TextDecoder('utf-16le')`, an encoding Expo's UTF-8-only decoder
 * rejects. The throw happens while the module is being evaluated, so it cannot be caught — the decoder
 * has to be compatible *before* the import is evaluated, which in ES modules means being imported
 * first. This was the launch crash of the first published APK (see ../../lib/text-encoding.ts).
 */
import '../text-encoding';

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

export interface CryptoRuntimeReport {
  /** True when the encryption layer can run on this device at all. */
  available: boolean;
  /** Where key material gets its entropy: `platform`, `expo-crypto`, or `none`. */
  random: string;
  /** Where AES/HMAC/SHA come from: `platform`, `bundled-pure-js`, or `none`. */
  primitives: string;
  /** True when the platform's own WebCrypto is used for both halves (browsers, Node). */
  native: boolean;
  /** Human-readable reason when `available` is false. */
  reason: string | null;
}

let report: CryptoRuntimeReport | null = null;
let applied = false;

/**
 * Resolves the runtime **once**, on demand.
 *
 * It is deliberately not resolved at import time. The first version of this file threw from module
 * scope when no random source was found, and since the engine imports it at the top of the start-up
 * chain, a device where that resolution failed did not lose encryption — it lost the whole app, with
 * a crash and no explanation. The security rule is unchanged (no keys are ever generated without a
 * real CSPRNG), but it is now enforced where it belongs: at the moment encryption is asked for.
 */
function resolve(): CryptoRuntimeReport {
  if (report) return report;
  const random = randomSource();
  const subtle = subtleSource();
  const available = Boolean(random && subtle);
  report = {
    available,
    random: random?.source ?? 'none',
    primitives: subtle?.source ?? 'none',
    native: random?.source === 'platform' && subtle?.source === 'platform',
    reason: available
      ? null
      : 'لا يوجد مصدر عشوائية آمن على هذا الجهاز (expo-crypto / crypto.getRandomValues)، أو لا تتوفّر بدائيات التشفير — لذلك يُعطَّل التشفير الطرفي بدل توليد مفاتيح ضعيفة.',
  };
  if (available && !applied) {
    /**
     * A complete WebCrypto-shaped object for the library.
     *
     * Note what is *not* done here: no primitive is implemented in this project. Both parts come from
     * audited implementations — one from the platform, one shipped by the protocol library itself.
     */
    setWebCrypto({
      subtle: subtle!.subtle,
      getRandomValues: random!.getRandomValues,
    } as unknown as Crypto);
    applied = true;
  }
  if (available && !report.native) {
    // Printed once, on purpose: an operator should be able to see which implementations a device used
    // when a key-verification question comes up.
    console.info(`[e2ee] crypto runtime — randomness: ${report.random}, primitives: ${report.primitives}`);
  }
  return report;
}

/**
 * What the encryption layer runs on, for the settings screen and for diagnostics.
 * Safe to call anywhere: it never throws and never generates anything.
 */
export function cryptoRuntime(): CryptoRuntimeReport {
  return resolve();
}

/**
 * Makes the runtime ready for the protocol library.
 *
 * Throws **only** when encryption is actually attempted on a device that cannot do it safely. Callers
 * turn that into a visible state (the E2EE provider reports it and disables encrypted sends), which is
 * the honest outcome: the rest of the app keeps working, and nothing claims to be encrypted.
 */
export function ensureCryptoRuntime(): CryptoRuntimeReport {
  const resolved = resolve();
  if (!resolved.available) {
    throw new Error(
      `e2ee_runtime_unavailable (random: ${resolved.random}, primitives: ${resolved.primitives}) — ` +
        'install expo-crypto (native CSPRNG) or run where crypto.subtle exists',
    );
  }
  return resolved;
}
