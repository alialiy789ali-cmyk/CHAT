/**
 * Encrypted attachments: what goes inside an encrypted message body.
 *
 * A file in an encrypted conversation is encrypted **in the browser** before it is uploaded, so the
 * server stores bytes it cannot interpret. Two things follow from that, and this module exists to
 * keep both honest:
 *
 *   - the key that opens the file may never touch the server. It travels inside the encrypted
 *     message payload, which only the participant devices can read — the same envelope that carries
 *     the text carries the keys for that message's files;
 *   - everything the server deliberately does not learn about the file (its real name, its real
 *     type, whether it is an image or a voice note) also travels in that payload. The stored row
 *     says `encrypted.bin`, `application/octet-stream`, and that is the whole truth available to
 *     anyone but the recipients.
 *
 * There is no custom cryptography here: AES-256-GCM through the platform's WebCrypto, with a fresh
 * random key and IV per file (GCM authenticates as well as encrypts, so a file that was tampered
 * with in storage fails to open instead of opening wrong). What is ours is only the *envelope*
 * format below, versioned so a future change cannot be mistaken for a broken message.
 */
/** One encrypted file, described well enough for a recipient device to open it. */
export interface EncryptedFileDescriptor {
  /** Server-side attachment id this descriptor describes. */
  id: string;
  /** AES-256 key, base64. Travels inside the encrypted payload only. */
  key: string;
  /** 12-byte GCM nonce, base64. */
  iv: string;
  /** The real file name — the server stores a neutral placeholder instead. */
  name: string;
  /** The real MIME type — the server stores `application/octet-stream`. */
  type: string;
  /** Plaintext size in bytes (the stored size is the ciphertext size, which is larger). */
  size: number;
}

/**
 * The decrypted shape of an encrypted message.
 *
 * `v: 1` is the first version; a bare string (no JSON) is what older messages hold, and
 * `parseContent` accepts it so history keeps rendering.
 */
export interface EncryptedContent {
  v: 1;
  text: string;
  files: EncryptedFileDescriptor[];
}

const CONTENT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Copies a view into a plain ArrayBuffer.
 *
 * `Uint8Array` may be backed by a `SharedArrayBuffer` as far as the type system is concerned, which
 * WebCrypto refuses to accept; the copy makes the backing store unambiguous.
 */
function bytesOf(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function subtle(): SubtleCrypto {
  const available = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!available) throw new Error('webcrypto_unavailable');
  return available;
}

export interface SealedFile {
  /** Ciphertext of the file, plus the key material a recipient needs. */
  ciphertext: ArrayBuffer;
  key: string;
  iv: string;
}

/** Encrypts file bytes with a fresh key. Nothing is uploaded from here. */
export async function sealBytes(bytes: ArrayBuffer): Promise<SealedFile> {
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await subtle().importKey('raw', bytesOf(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv: bytesOf(iv) }, cryptoKey, bytes);
  return { ciphertext, key: toBase64(key), iv: toBase64(iv) };
}

/**
 * Opens a file with the key that came inside the encrypted message.
 *
 * A wrong key, a truncated download or a byte flipped in storage all fail here rather than
 * producing a silently corrupted file — that is GCM's authentication tag doing its job.
 */
export async function openBytes(
  ciphertext: ArrayBuffer,
  descriptor: Pick<EncryptedFileDescriptor, 'key' | 'iv'>,
): Promise<ArrayBuffer> {
  const cryptoKey = await subtle().importKey('raw', bytesOf(fromBase64(descriptor.key)), 'AES-GCM', false, [
    'decrypt',
  ]);
  return subtle().decrypt({ name: 'AES-GCM', iv: bytesOf(fromBase64(descriptor.iv)) }, cryptoKey, ciphertext);
}

/**
 * Prepares one file for upload.
 *
 * Returns the multipart body (ciphertext only) and a `describe` function that turns the attachment
 * id the server assigns into the descriptor that will travel inside the message payload. Splitting
 * it this way keeps the upload request free of anything readable: the declared name is a constant,
 * because the real one is added after the server has already stored the bytes.
 */
export async function sealFileForUpload(file: File | Blob, name: string, type: string): Promise<{
  form: FormData;
  describe: (attachmentId: string) => EncryptedFileDescriptor;
}> {
  const bytes = await file.arrayBuffer();
  const sealed = await sealBytes(bytes);
  const form = new FormData();
  // The flag tells the server not to sniff or judge these bytes: ciphertext has no signature.
  form.append('encrypted', 'true');
  form.append('file', new Blob([sealed.ciphertext], { type: 'application/octet-stream' }), 'encrypted.bin');
  return {
    form,
    describe: (attachmentId: string) => ({
      id: attachmentId,
      key: sealed.key,
      iv: sealed.iv,
      name,
      type,
      size: bytes.byteLength,
    }),
  };
}

/** Builds the plaintext that gets encrypted into an envelope for a message with files. */
export function encodeContent(text: string, files: EncryptedFileDescriptor[]): string {
  if (files.length === 0) return text;
  return JSON.stringify({ v: CONTENT_VERSION, text, files } satisfies EncryptedContent);
}

/**
 * Reads an encrypted message body.
 *
 * Messages written before this version are plain text, and a JSON-looking *human* message must not
 * be misread as a payload — the version field is what makes that distinction, so anything without
 * `v: 1` is treated as text.
 */
export function parseContent(plaintext: string): EncryptedContent {
  if (plaintext.startsWith('{')) {
    try {
      const parsed = JSON.parse(plaintext) as Partial<EncryptedContent>;
      if (parsed.v === CONTENT_VERSION && typeof parsed.text === 'string') {
        const files = Array.isArray(parsed.files) ? parsed.files.filter(isDescriptor) : [];
        return { v: CONTENT_VERSION, text: parsed.text, files };
      }
    } catch {
      // Not JSON at all: fall through to the plain-text path.
    }
  }
  return { v: CONTENT_VERSION, text: plaintext, files: [] };
}

function isDescriptor(value: unknown): value is EncryptedFileDescriptor {
  const candidate = value as Partial<EncryptedFileDescriptor> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    typeof candidate.key === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.size === 'number'
  );
}

/** The descriptor for one attachment id, if this message carried one. */
export function descriptorFor(files: EncryptedFileDescriptor[], attachmentId: string): EncryptedFileDescriptor | null {
  return files.find((file) => file.id === attachmentId) ?? null;
}

/**
 * Fetches stored bytes.
 *
 * `url` must already be an authorised media URL (see `lib/media.ts`); this helper never invents
 * credentials, which keeps the token policy in one place.
 */
export async function downloadBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download_failed:${response.status}`);
  return response.arrayBuffer();
}

/** The ciphertext of an encrypted attachment — the same bytes the server holds. */
export async function openCiphertext(ciphertextUrl: string, descriptor: EncryptedFileDescriptor): Promise<ArrayBuffer> {
  return openBytes(await downloadBytes(ciphertextUrl), descriptor);
}

/** A blob a browser can render or save, typed with the real MIME type from the payload. */
export async function openAsBlob(ciphertextUrl: string, descriptor: EncryptedFileDescriptor): Promise<Blob> {
  const plaintext = await openCiphertext(ciphertextUrl, descriptor);
  return new Blob([plaintext], { type: descriptor.type || 'application/octet-stream' });
}
