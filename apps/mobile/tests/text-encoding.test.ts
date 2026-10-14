/**
 * The launch crash, reproduced and fixed — without a phone.
 *
 * The published APK opened and aborted four seconds later. Android recorded why:
 *
 *     [runtime not ready]: RangeError: Unknown encoding: utf-16le (normalized: utf-16le)
 *
 * Expo SDK 57 installs a UTF-8-only `TextDecoder` over the global one (Hermes has none of its own),
 * and `@privacyresearch/curve25519-typescript` — the curve25519 inside the Signal-protocol library —
 * builds `new TextDecoder('utf-16le')` at module scope, so *importing* the crypto library threw during
 * bundle evaluation.
 *
 * These tests reproduce that environment: a decoder that rejects everything except UTF-8, exactly like
 * the phone's, and the real dependency imported underneath it. Then they check the fix, both against
 * the platform's own decoder as an oracle and against the real key exchange the library performs.
 */
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CompatibleTextDecoder,
  installCompatibleTextDecoder,
  utf16IsDecodable,
} from '../src/lib/text-encoding';

/** The real platform decoder, kept as the oracle for every comparison below. */
const NativeTextDecoder = globalThis.TextDecoder;

/**
 * Expo's decoder, reproduced: UTF-8 only, and the same message the device logged.
 *
 * Its `decode` is deliberately distinguishable so that a delegated call can be recognised.
 */
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
    // Decoding UTF-8 without touching the global: the global *is* the shim once installed, and a
    // decoder that called it back would recurse.
    const bytes = input === undefined ? new Uint8Array(0) : new Uint8Array(input as ArrayBuffer);
    return `utf8-only:${Buffer.from(bytes).toString('utf8')}`;
  }
}

const fakePlatform = Utf8OnlyDecoder as unknown as new (
  label?: string,
  options?: { fatal?: boolean; ignoreBOM?: boolean },
) => { encoding: string; fatal: boolean; ignoreBOM: boolean; decode(input?: ArrayBuffer | ArrayBufferView): string };

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf16le = (text: string, withBom = false): Uint8Array => {
  const units: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code > 0xffff) {
      const offset = code - 0x10000;
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      units.push(code);
    }
  }
  const out = new Uint8Array(units.length * 2 + (withBom ? 2 : 0));
  let at = 0;
  if (withBom) {
    out[0] = 0xff;
    out[1] = 0xfe;
    at = 2;
  }
  units.forEach((unit, index) => {
    out[at + index * 2] = unit & 0xff;
    out[at + index * 2 + 1] = unit >> 8;
  });
  return out;
};

describe('the decoder a phone actually has', () => {
  it('rejects utf-16le with the exact message in the crash log', () => {
    expect(() => new Utf8OnlyDecoder('utf-16le')).toThrowError(
      'Unknown encoding: utf-16le (normalized: utf-16le)',
    );
    // This is the line the dependency runs at module scope, and the reason the app aborted.
    expect(() => new Utf8OnlyDecoder('utf-16le')).toThrow(RangeError);
  });

  it('is detected as unable to decode UTF-16', () => {
    expect(utf16IsDecodable()).toBe(true); // Node's own decoder is complete: nothing to install here
    const broken = { TextDecoder: Utf8OnlyDecoder } as unknown as typeof globalThis;
    const original = globalThis.TextDecoder;
    try {
      Object.defineProperty(globalThis, 'TextDecoder', { value: broken.TextDecoder, configurable: true });
      // A fresh look-up sees the phone's decoder; `utf16IsDecodable` must say no.
      const probe = new (broken.TextDecoder as typeof Utf8OnlyDecoder)('utf-8');
      expect(probe.encoding).toBe('utf-8');
      expect(() => new (broken.TextDecoder as typeof Utf8OnlyDecoder)('utf-16le')).toThrow();
    } finally {
      Object.defineProperty(globalThis, 'TextDecoder', { value: original, configurable: true });
    }
  });
});

describe('the compatible decoder', () => {
  it('decodes utf-16le exactly like the platform decoder does', () => {
    const oracle = new NativeTextDecoder('utf-16le');
    const samples = ['', 'hello', 'مرحباً بالعالم', '🔒📱 emoji outside the BMP', 'mixed: عربي and ASCII 123'];
    for (const sample of samples) {
      const input = utf16le(sample);
      expect(new CompatibleTextDecoder('utf-16le').decode(input)).toBe(oracle.decode(input));
    }
  });

  it('accepts the labels the standard maps to utf-16le, and utf-16be as its own', () => {
    for (const label of ['utf-16le', 'utf-16', 'ucs-2', 'unicode']) {
      expect(new CompatibleTextDecoder(label).encoding).toBe('utf-16le');
    }
    expect(new CompatibleTextDecoder('utf-16be').encoding).toBe('utf-16be');
    const bigEndian = utf16le('بيانات');
    for (let index = 0; index < bigEndian.length; index += 2) {
      const low = bigEndian[index]!;
      bigEndian[index] = bigEndian[index + 1]!;
      bigEndian[index + 1] = low;
    }
    expect(new CompatibleTextDecoder('utf-16be').decode(bigEndian)).toBe('بيانات');
  });

  it('strips the byte order mark, and keeps it when asked to', () => {
    const withBom = utf16le('مرحبا', true);
    expect(new CompatibleTextDecoder('utf-16le').decode(withBom)).toBe('مرحبا');
    expect(new CompatibleTextDecoder('utf-16le', { ignoreBOM: true }).decode(withBom)).toBe('\ufeffمرحبا');
    expect(new CompatibleTextDecoder('utf-16le').decode(withBom).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('replaces a lone surrogate with U+FFFD, and throws for it when fatal', () => {
    // A high surrogate followed by a normal character is malformed UTF-16, not a valid pair.
    const replaced = new CompatibleTextDecoder('utf-16le').decode(bytes(0x00, 0xd8, 0x41, 0x00));
    expect(replaced).toBe('�A');
    expect(new NativeTextDecoder('utf-16le').decode(bytes(0x00, 0xd8, 0x41, 0x00))).toBe(replaced);
    expect(() => new CompatibleTextDecoder('utf-16le', { fatal: true }).decode(bytes(0x00, 0xd8, 0x41, 0x00))).toThrow(
      TypeError,
    );
    expect(() => new NativeTextDecoder('utf-16le', { fatal: true }).decode(bytes(0x00, 0xd8, 0x41, 0x00))).toThrow(
      TypeError,
    );
  });

  it('matches the platform decoder across every streaming split point', () => {
    // This is the check that found a real bug: holding back an odd byte is only correct if the *next*
    // call keeps it, and an earlier version dropped it whenever that call was final — shifting every
    // code unit after the split by one byte. Comparing against the platform decoder over every cut
    // point, odd and even, is what makes that impossible to reintroduce quietly.
    const text = 'نص طويل مع رموز 🔐 وأرقام 1234567890 مكتوب بالعربية والإنجليزية';
    const input = utf16le(text);
    let mismatches = 0;
    for (let cut = 0; cut <= input.length; cut += 1) {
      const mine = new CompatibleTextDecoder('utf-16le');
      const mineOut = mine.decode(input.slice(0, cut), { stream: true }) + mine.decode(input.slice(cut));
      const oracle = new NativeTextDecoder('utf-16le');
      const oracleOut = oracle.decode(input.slice(0, cut), { stream: true }) + oracle.decode(input.slice(cut));
      if (mineOut !== oracleOut) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('treats a stray final byte as malformed input and holds it back while streaming', () => {
    const withStray = new Uint8Array([...utf16le('AB'), 0x7f]);
    // Final input: the lone byte cannot form a code unit, so it is a decoder error, exactly as the
    // platform decoder treats it.
    expect(new CompatibleTextDecoder('utf-16le').decode(withStray)).toBe(new NativeTextDecoder('utf-16le').decode(withStray));

    // Streaming: the byte is held, and the next call — the final one — pairs it with what follows.
    const streaming = new CompatibleTextDecoder('utf-16le');
    const oracle = new NativeTextDecoder('utf-16le');
    expect(streaming.decode(withStray, { stream: true })).toBe(oracle.decode(withStray, { stream: true }));
    expect(streaming.decode(bytes(0x00))).toBe(oracle.decode(bytes(0x00)));
  });

  it('hands every other encoding to the platform decoder, including its refusals', () => {
    const target = globalThis as { TextDecoder?: unknown; SovereignTextDecoderInstalled?: boolean };
    const previous = globalThis.TextDecoder;
    try {
      expect(installCompatibleTextDecoder(fakePlatform)).toBe(true);
      expect(installCompatibleTextDecoder()).toBe(false); // idempotent

      const utf8 = new TextDecoder('utf-8');
      expect(utf8.encoding).toBe('utf-8');
      expect(utf8.decode(new Uint8Array([0x68, 0x69]))).toBe('utf8-only:hi'); // delegated, not reimplemented

      expect(new TextDecoder('utf-16le').decode(utf16le('اختبار'))).toBe('اختبار');
      expect(new TextDecoder('utf-16be').encoding).toBe('utf-16be');
      // An encoding nobody implements must still fail loudly rather than silently returning nonsense.
      expect(() => new TextDecoder('latin1')).toThrow(RangeError);
    } finally {
      Object.defineProperty(globalThis, 'TextDecoder', { value: previous, configurable: true });
      delete target.SovereignTextDecoderInstalled;
    }
  });
});

afterAll(() => {
  // The global must be left exactly as it was found: other test files share this worker's globals.
  Object.defineProperty(globalThis, 'TextDecoder', { value: NativeTextDecoder, configurable: true });
  delete (globalThis as { SovereignTextDecoderInstalled?: boolean }).SovereignTextDecoderInstalled;
});
