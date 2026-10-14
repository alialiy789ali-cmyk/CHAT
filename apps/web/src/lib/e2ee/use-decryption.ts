'use client';

/**
 * Turns encrypted rows from the API into readable text for the thread.
 *
 * A message can be readable in four different ways, and the UI must distinguish them rather than
 * showing a blank bubble:
 *
 *   plaintext   — the conversation is not encrypted
 *   decrypted   — this device held the key and recovered the text just now
 *   locked      — no envelope exists for this device (e.g. it was added later, or the message was
 *                 sent from another device that did not address this one)
 *   failed      — the ciphertext did not authenticate (tampering, or the ratchet was reset)
 *
 * Decrypted text is written to the local cache by the engine, so the work happens once per message
 * per device and the thread renders instantly on the next visit.
 */
import { useEffect, useRef, useState } from 'react';
import type { E2eeEngine } from './engine';
import { loadPlaintext } from './store';
import type { MessageLockState } from './types';

export interface EncryptedRow {
  id: string;
  conversationId: string;
  encryptionScheme: string;
  envelopes?: Array<{ deviceId: string; scheme: string; ciphertext: string }>;
  sender: { id: string } | null;
}

export interface DecryptionState {
  /** message id → plaintext for this device */
  plaintext: Map<string, string>;
  /** message id → why the text is (not) available */
  lockState: Map<string, MessageLockState>;
}

const EMPTY: DecryptionState = { plaintext: new Map(), lockState: new Map() };

export function useDecryption(
  engine: E2eeEngine | null,
  viewerId: string | null,
  rows: EncryptedRow[],
): DecryptionState {
  const [state, setState] = useState<DecryptionState>(EMPTY);
  /** Ids already attempted, so a failing message is not retried on every render. */
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!engine || !viewerId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    (async () => {
      const plaintext = new Map(state.plaintext);
      const lockState = new Map(state.lockState);
      let changed = false;

      for (const row of rows) {
        if (row.encryptionScheme === 'none') {
          lockState.set(row.id, 'plaintext');
          continue;
        }
        if (plaintext.has(row.id)) continue;

        // The cache is the first stop: it survives reloads and works offline. It is scoped to
        // this device, so another account in the same browser cannot read text it never held.
        const cached = await loadPlaintext(row.id, engine.deviceId);
        if (cached) {
          plaintext.set(row.id, cached.body);
          lockState.set(row.id, 'decrypted');
          changed = true;
          continue;
        }
        if (attempted.current.has(row.id)) continue;
        lockState.set(row.id, 'pending');
        changed = true;

        try {
          // History responses carry this device's envelope inline; a real-time frame cannot (one
          // frame reaches every device), so fetch the envelope for that case.
          const envelope =
            row.envelopes && row.envelopes.length > 0
              ? { deviceId: row.envelopes[0]!.deviceId, scheme: 'olm-v1' as const, ciphertext: row.envelopes[0]!.ciphertext }
              : await engine.fetchEnvelope(row.id);
          if (!envelope) {
            lockState.set(row.id, 'locked');
            attempted.current.add(row.id);
            continue;
          }
          const text = await engine.decryptEnvelope({
            messageId: row.id,
            conversationId: row.conversationId,
            senderUserId: row.sender?.id ?? '',
            envelope,
            mine: row.sender?.id === viewerId,
          });
          plaintext.set(row.id, text);
          lockState.set(row.id, 'decrypted');
        } catch (error) {
          console.warn('decryption failed', row.id, error);
          lockState.set(row.id, 'failed');
          attempted.current.add(row.id);
        }
        changed = true;
      }

      if (!cancelled && changed) setState({ plaintext, lockState });
    })();

    return () => {
      cancelled = true;
    };
    // `state` is read but not a dependency: this effect drives the state forward itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, viewerId, rows]);

  return state;
}
