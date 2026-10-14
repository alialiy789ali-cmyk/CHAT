/**
 * `TextDecoder` that also understands UTF-16 — the fix for the app closing on launch.
 *
 * **What happened.** The published APK opened and died four seconds later. The emulator finally gave
 * the reason, in Android's own words:
 *
 *     Abort message: 'terminating due to uncaught exception of type facebook::jni::JniException:
 *     com.facebook.react.common.JavascriptException: [runtime not ready]:
 *     RangeError: Unknown encoding: utf-16le (normalized: utf-16le)'
 *
 * That message is Expo's, and it comes from Expo SDK 57's WinterCG runtime, which installs a
 * **UTF-8-only** `TextDecoder` over the global one. Hermes has none of its own, so the global decoder
 * supports exactly one encoding on a phone.
 *
 * The stack that hit it belongs to a dependency: `@privacyresearch/curve25519-typescript` is the
 * curve25519 the Signal-protocol library uses, it ships as emscripten output, and its Emscripten glue
 * builds `new TextDecoder('utf-16le')` **at module scope** — before a single function of it is called.
 * Importing the crypto library is therefore enough to throw, inside bundle evaluation, which React
 * Native reports as "runtime not ready" and turns into a process abort. Nothing in this app's own code
 * is involved: the app never asked for UTF-16.
 *
 * **What this does.** Installs a `TextDecoder` that keeps whatever the platform provides and adds the
 * one encoding the dependency needs, decoded here against the WHATWG rules (BOM handling, surrogate
 * pairs, `fatal`, streaming). It is deliberately narrow: UTF-16 little- and big-endian are implemented,
 * every other label is handed to the platform's decoder so unknown encodings still fail exactly as they
 * did. It is installed before the crypto library is imported — see the import order in
 * `./e2ee/runtime.ts` and `../../index.ts` — because the throw happens during module evaluation, where
 * a try/catch cannot reach it.
 *
 * This is not cryptography and does not touch key material; it is the difference between an app that
 * starts and one that does not.
 */

const UTF16LE_LABELS = new Set(['utf-16le', 'utf-16', 'ucs-2', 'unicode', 'unicodefeff', 'csunicode', 'iso-10646-ucs-2']);
const UTF16BE_LABELS = new Set(['utf-16be', 'unicodefffe']);

type DecodeInput = ArrayBuffer | ArrayBufferView;

interface DecoderLike {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: DecodeInput, options?: { stream?: boolean }): string;
}

type DecoderConstructor = new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => DecoderLike;

interface Utf16State {
  bomSeen: boolean;
  pending: Uint8Array;
  streaming: boolean;
}

function normalise(label: unknown): string {
  return String(label ?? 'utf-8').trim().toLowerCase();
}

function bytesOf(input: DecodeInput | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input as ArrayBuffer);
}

function joinBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const merged = new Uint8Array(first.length + second.length);
  merged.set(first, 0);
  merged.set(second, first.length);
  return merged;
}

/**
 * Builds the string for a run of code units without spreading a huge array into `fromCharCode`.
 *
 * The values are UTF-16 code units, not code points, so a surrogate pair is written as its two units:
 * `String.fromCharCode` would do exactly that for the pair's two halves, and keeping the units keeps
 * the check below honest about unpaired surrogates.
 */
function fromCodeUnits(units: number[]): string {
  let output = '';
  for (let index = 0; index < units.length; index += 2048) {
    output += String.fromCharCode(...units.slice(index, index + 2048));
  }
  return output;
}

/**
 * WHATWG-style UTF-16 decoding.
 *
 * Byte order is the caller's parameter (that is the only difference between the two encodings), and the
 * BOM is stripped unless `ignoreBOM` says otherwise. A high surrogate with no low surrogate after it,
 * or a low surrogate on its own, is a decoder error: with `fatal` it throws, otherwise it becomes
 * U+FFFD — the same contract the platform decoder follows.
 */
function decodeUtf16(
  input: Uint8Array,
  littleEndian: boolean,
  options: { fatal: boolean; ignoreBOM: boolean; stream: boolean },
  state: Utf16State,
): string {
  const bytes = joinBytes(state.pending, input);
  state.pending = new Uint8Array(0);

  let offset = 0;
  if (!state.bomSeen) {
    if (bytes.length < 2 && options.stream) {
      // Not enough bytes to know whether a BOM is coming; keep them for the next call.
      state.pending = bytes;
      state.streaming = true;
      return '';
    }
    if (bytes.length >= 2) {
      const byteOrderMark = littleEndian ? [0xff, 0xfe] : [0xfe, 0xff];
      if (bytes[0] === byteOrderMark[0] && bytes[1] === byteOrderMark[1] && !options.ignoreBOM) offset = 2;
    }
    state.bomSeen = true;
  }

  const units: number[] = [];
  const readUnit = (at: number): number =>
    littleEndian ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;

  const error = (): void => {
    if (options.fatal) throw new TypeError('Decoder error');
    units.push(0xfffd);
  };

  while (offset + 1 < bytes.length) {
    const unit = readUnit(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (offset + 3 >= bytes.length) {
        if (options.stream) {
          // The low surrogate may still be on its way: hand these two bytes to the next call.
          state.pending = bytes.slice(offset);
          state.streaming = true;
          return fromCodeUnits(units);
        }
        error();
        offset += 2;
        continue;
      }
      const next = readUnit(offset + 2);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units.push(unit, next);
        offset += 4;
        continue;
      }
      error();
      offset += 2;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      error();
      offset += 2;
      continue;
    }
    units.push(unit);
    offset += 2;
  }

  if (offset < bytes.length) {
    // A single trailing byte with no partner. Final input: that is a malformed last code unit.
    if (options.stream) {
      state.pending = bytes.slice(offset);
      state.streaming = true;
    } else {
      error();
    }
  }
  state.streaming = options.stream;
  return fromCodeUnits(units);
}

class CompatibleTextDecoder implements DecoderLike {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  private readonly platform: DecoderLike | null;
  private readonly littleEndian: boolean | null;
  private readonly state: Utf16State = { bomSeen: false, pending: new Uint8Array(0), streaming: false };

  constructor(label: string = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (options != null && typeof options !== 'object') {
      throw new TypeError('Second argument of TextDecoder must be undefined or an object, e.g. { fatal: true }');
    }
    const normalized = normalise(label);
    this.fatal = Boolean(options.fatal);
    this.ignoreBOM = Boolean(options.ignoreBOM);

    if (UTF16LE_LABELS.has(normalized) || UTF16BE_LABELS.has(normalized)) {
      this.encoding = UTF16LE_LABELS.has(normalized) ? 'utf-16le' : 'utf-16be';
      this.littleEndian = UTF16LE_LABELS.has(normalized);
      this.platform = null;
      return;
    }
    this.encoding = normalized;
    this.littleEndian = null;
    // Everything else is the platform's business, including refusing encodings it does not know.
    const Platform = baseDecoder();
    if (!Platform) throw new RangeError(`Unknown encoding: ${label} (normalized: ${normalized})`);
    const delegate = new Platform(label, { fatal: this.fatal, ignoreBOM: this.ignoreBOM });
    this.platform = delegate;
    this.encoding = delegate.encoding;
  }

  decode(input?: DecodeInput, options: { stream?: boolean } = {}): string {
    const stream = Boolean(options?.stream);
    /**
     * The reset is decided by the *previous* call, not this one, and that distinction is the whole
     * streaming contract: bytes held back by a call that asked for `stream: true` belong to the next
     * call even when that call ends the stream. Resetting on the current flag would drop the held byte
     * and shift every code unit after it by one byte — a bug this implementation had, caught by
     * comparing against the platform decoder across every split point.
     */
    if (!this.state.streaming) {
      this.state.bomSeen = false;
      this.state.pending = new Uint8Array(0);
    }
    const bytes = bytesOf(input);
    if (this.platform) {
      // A non-UTF-16 label: the platform decoder stays authoritative, including its own errors.
      return this.platform.decode(bytes, { stream });
    }
    return decodeUtf16(bytes, this.littleEndian === true, { fatal: this.fatal, ignoreBOM: this.ignoreBOM, stream }, this.state);
  }
}

/**
 * The decoder this platform had before this module was imported.
 *
 * Captured once, deliberately: after installation the global *is* this shim, so asking the global for
 * "the platform decoder" would return the shim itself. `undefined` means "not looked up yet", `null`
 * means "the platform has none".
 */
let base: DecoderConstructor | null | undefined;

function baseDecoder(): DecoderConstructor | null {
  if (base === undefined) {
    const candidate = (globalThis as { TextDecoder?: unknown }).TextDecoder;
    base =
      typeof candidate === 'function' && candidate !== (CompatibleTextDecoder as unknown)
        ? (candidate as DecoderConstructor)
        : null;
  }
  return base;
}

interface Installable {
  TextDecoder?: unknown;
  SovereignTextDecoderInstalled?: boolean;
}

/**
 * Replaces the global `TextDecoder` with the compatible one.
 *
 * `platform` is only for tests, which need to see the shim against the decoder a phone actually has;
 * in the app it is omitted and the current global is captured first. Returns whether it installed, so a
 * caller can tell "already compatible" from "replaced" — and calling it twice is harmless, which
 * matters because the entry point and the crypto runtime both import this module.
 */
export function installCompatibleTextDecoder(platform?: DecoderConstructor | null): boolean {
  const target = globalThis as Installable;
  if (target.SovereignTextDecoderInstalled) return false;
  if (platform !== undefined) base = platform;
  else baseDecoder();
  target.TextDecoder = CompatibleTextDecoder as unknown as DecoderConstructor;
  target.SovereignTextDecoderInstalled = true;
  return true;
}

/** Whether the running decoder can actually decode UTF-16 (the thing that decides installing). */
export function utf16IsDecodable(): boolean {
  try {
    const decoder = new (baseDecoder() ?? (globalThis as { TextDecoder: DecoderConstructor }).TextDecoder)('utf-16le');
    return decoder.encoding === 'utf-16le';
  } catch {
    return false;
  }
}

/**
 * Installed here, at module scope, and only when the platform's decoder cannot do UTF-16.
 *
 * The library that needs it throws while *its* module is being evaluated, so a check that runs later —
 * in a function, in a component, in an error boundary — would be too late to prevent the abort. Making
 * this module the thing that is imported first is the mechanism; the UTF-8 check keeps it from
 * replacing a decoder that is already complete (Node, a browser).
 */
if (!utf16IsDecodable()) installCompatibleTextDecoder();

export { CompatibleTextDecoder };
