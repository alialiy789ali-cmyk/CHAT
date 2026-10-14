/**
 * How an encrypted message body should read on screen.
 *
 * This looks like something a component could decide inline, and it was — which is how an
 * attachment-only message came to sit in the thread saying "decrypting…" forever. The bug was a
 * collision of two different meanings of "no text": *the text is not here yet* and *this message has
 * no text, it is a file*. Only the first one is a waiting state; the second one is finished, and
 * showing "decrypting…" for it tells the user something false about their own message.
 *
 * So the decision is a pure function of two inputs — the decrypted payload (or nothing), and what the
 * decryption pass said about this row — and it is tested without a browser:
 * `apps/web/scripts/ui-state-check.mts`.
 */
import type { EncryptedContent } from './content';
import type { MessageLockState } from './types';

export type BodyPresentation =
  /** Wait for the text to arrive; this row is still being decrypted. */
  | { kind: 'pending' }
  /** No envelope for this device: the key never reached it. */
  | { kind: 'locked' }
  /** The ciphertext failed to authenticate (tampering, or the ratchet was reset). */
  | { kind: 'failed' }
  /** The payload arrived and carries text to show. */
  | { kind: 'text'; text: string }
  /** The payload arrived and is only files — the attachments below the bubble *are* the message. */
  | { kind: 'attachments' }
  /** The payload arrived and is genuinely empty: neither text nor files. */
  | { kind: 'empty' };

export function bodyPresentation(content: EncryptedContent | null, state: MessageLockState): BodyPresentation {
  if (content) {
    if (content.text.length > 0) return { kind: 'text', text: content.text };
    // `text: ''` next to files is not a missing text, it is a message whose whole content is the file.
    if (content.files.length > 0) return { kind: 'attachments' };
    return { kind: 'empty' };
  }
  if (state === 'failed') return { kind: 'failed' };
  if (state === 'locked') return { kind: 'locked' };
  return { kind: 'pending' };
}
