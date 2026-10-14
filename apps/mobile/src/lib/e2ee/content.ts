/**
 * Plaintext cache for the current device.
 *
 * Ciphertext is all the server ever holds, so the phone is the only place the readable text of an
 * encrypted message exists. Two consequences drive this file:
 *
 *  - the cache is keyed by **device id as well as message id**. Two accounts in the same app install
 *    (or a device that was re-provisioned) must never read each other's cached text, which the
 *    web client learned the hard way when a message id alone collided;
 *  - a message that is still decrypting must not be mistaken for an empty one, so "no entry" and
 *    "empty text" are distinct states and callers get `null` for the former.
 */
import type { KeyValueBackend } from './types';

const prefix = (deviceId: string): string => `e2ee:${deviceId}:plaintext:`;

export class PlaintextCache {
  constructor(
    private readonly backend: KeyValueBackend,
    private readonly deviceId: string,
  ) {}

  async put(messageId: string, plaintext: string): Promise<void> {
    await this.backend.set(`${prefix(this.deviceId)}${messageId}`, plaintext);
  }

  async get(messageId: string): Promise<string | null> {
    return this.backend.get(`${prefix(this.deviceId)}${messageId}`);
  }

  async has(messageId: string): Promise<boolean> {
    return (await this.get(messageId)) !== null;
  }

  async forget(messageId: string): Promise<void> {
    await this.backend.remove(`${prefix(this.deviceId)}${messageId}`);
  }

  /** Drops every cached plaintext for this device — used when a device is signed out. */
  async clear(): Promise<void> {
    for (const key of await this.backend.keys(prefix(this.deviceId))) await this.backend.remove(key);
  }
}
