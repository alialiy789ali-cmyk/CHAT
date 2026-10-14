/**
 * The launch crash, reproduced on purpose — the half of the demonstration that must fail.
 *
 * Android's record of the first published APK's death was:
 *
 *     [runtime not ready]: RangeError: Unknown encoding: utf-16le (normalized: utf-16le)
 *
 * This file recreates the phone's conditions and shows the same import failing with the same message,
 * so the fix in `libsignal-loading.test.ts` is measured against a real fault and not against a guess
 * about one. The test asserts a *failure*, which is why it lives alone: the dependency is imported once,
 * first, under the UTF-8-only decoder a phone has.
 */
import { describe, expect, it } from 'vitest';

/** Expo SDK 57's decoder, as installed over the global one: UTF-8 only, with the message from the log. */
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

describe('the crypto library on a phone without a UTF-16 decoder', () => {
  it('dies while being imported, exactly where the device died', async () => {
    Object.defineProperty(globalThis, 'TextDecoder', { value: Utf8OnlyDecoder, configurable: true });

    // `@privacyresearch/curve25519-typescript` is the curve25519 inside the Signal-protocol library.
    // Its Emscripten glue runs `new TextDecoder('utf-16le')` at module scope, so the throw is not in a
    // function that anyone could wrap: it happens while the module is being evaluated.
    let failure: unknown = null;
    try {
      await import('@privacyresearch/curve25519-typescript');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RangeError);
    expect((failure as RangeError).message).toBe('Unknown encoding: utf-16le (normalized: utf-16le)');

    // And the same construction on its own, which is the line the dependency runs at module scope.
    const Ctor = (globalThis as unknown as { TextDecoder: new (label: string) => unknown }).TextDecoder;
    expect(() => new Ctor('utf-16le')).toThrowError('Unknown encoding: utf-16le (normalized: utf-16le)');
  });
});
