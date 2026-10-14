/**
 * Content-type detection from the bytes themselves.
 *
 * The declared `Content-Type` of an upload is attacker-controlled, and "the browser said image/png"
 * is not evidence that a file is a PNG. Everything that later trusts a MIME type — the `<img>` tag
 * that renders it, the media element, the download's `Content-Disposition` — is safer when the server
 * has looked at the first bytes and agreed.
 *
 * This is deliberately *not* a general-purpose file-type library: it knows exactly the types the
 * upload allow-list accepts (`uploads.service.ts`), plus the two container families that need special
 * handling (zip-based Office documents, and text formats that have no signature at all). A type this
 * function cannot recognise is rejected rather than trusted.
 *
 * Deliberate exception: **end-to-end encrypted uploads are not sniffed**. Ciphertext has no signature
 * by design, so those carry an explicit flag instead (`encrypted` in the upload), are stored as
 * `application/octet-stream`, and the real file name and type travel inside the encrypted payload
 * where the server cannot read them.
 */

/** True when the declared type and the bytes are the same kind of thing. */
const COMPATIBLE: Record<string, string[]> = {
  // The same container can legitimately be declared as audio or video (a WebM with only audio).
  'video/webm': ['audio/webm'],
  'audio/webm': ['video/webm'],
  // Opus in Ogg: the container is Ogg, the codec is Opus.
  'audio/ogg': ['audio/opus'],
  'audio/opus': ['audio/ogg'],
  // Office documents and ODF files are zip archives with a manifest inside.
  'application/zip': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
  ],
  // Text formats share no signature; they are told apart by their content, not their first bytes.
  'text/plain': ['application/json', 'text/markdown', 'text/csv'],
  'application/json': ['text/plain'],
  'text/markdown': ['text/plain'],
  'text/csv': ['text/plain'],
  // MP4 containers cover video and audio alike.
  'video/mp4': ['audio/mp4', 'audio/aac'],
  'audio/mp4': ['video/mp4'],
};

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  Buffer.from(bytes.subarray(start, start + length)).toString('latin1');

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

/** ISO base media file format (mp4/mov/m4a/avif): a `ftyp` box listing compatible brands. */
function isoBrand(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  return ascii(bytes, 8, 4);
}

/** Looks like text: no NUL bytes and almost only printable/whitespace characters. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127);
    if (!printable) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) < 0.02;
}

/**
 * The type the bytes themselves claim, or `null` when nothing matches.
 *
 * Returning `null` is a normal outcome for a format this project does not accept; the caller turns it
 * into a refusal.
 */
export function detectMediaType(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  // Images ---------------------------------------------------------------
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  const brand = isoBrand(bytes);
  if (brand === 'avif' || brand === 'avis') return 'image/avif';
  if (brand === 'qt  ') return 'video/quicktime';
  if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
  if (brand !== null) return 'video/mp4';

  // Video / audio containers --------------------------------------------
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(bytes, 0, 4) === 'OggS') {
    // Opus and Vorbis both live in Ogg; the codec name appears in the first page.
    return ascii(bytes, 0, 64).includes('OpusHead') ? 'audio/opus' : 'audio/ogg';
  }
  if (ascii(bytes, 0, 3) === 'ID3' || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) {
    return 'audio/mpeg';
  }
  if (startsWith(bytes, [0xff, 0xf1]) || startsWith(bytes, [0xff, 0xf9])) return 'audio/aac';

  // Documents ------------------------------------------------------------
  if (ascii(bytes, 0, 4) === '%PDF') return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return 'application/zip';
  }
  if (looksLikeText(bytes)) return 'text/plain';

  return null;
}

/**
 * Whether a declared MIME type is consistent with the bytes.
 *
 * `detected === declared` is the normal case; `COMPATIBLE` covers the handful of declarations that are
 * genuinely the same content under another name (a docx *is* a zip, an Opus file *is* an Ogg stream).
 */
export function isTypeConsistent(declared: string, detected: string | null): boolean {
  if (!detected) return false;
  if (declared === detected) return true;
  return (COMPATIBLE[detected] ?? []).includes(declared) || (COMPATIBLE[declared] ?? []).includes(detected);
}
