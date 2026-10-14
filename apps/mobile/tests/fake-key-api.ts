/**
 * An in-memory stand-in for the key-distribution API, used by the mobile engine's unit tests.
 *
 * Why a fake at all: these tests prove the *client's* protocol decisions — who gets an envelope, when
 * a one-time prekey is claimed, what happens when a key changed — and those decisions are made on the
 * phone, between real libsignal calls. The API contract itself is proven against a real server by
 * `apps/server/tests/e2e/acceptance.test.ts` and by `apps/mobile/scripts/e2ee-live-test.mts`, so this
 * fake only has to mirror the endpoints faithfully:
 *
 *   PUT  /api/keys/identity          publish identity + signed prekey (+ one-time prekeys)
 *   POST /api/keys/prekeys           top the pool up
 *   GET  /api/keys/me                this account's inventory
 *   GET  /api/keys/:userId/devices   descriptors only — never claims (free of side effects)
 *   GET  /api/keys/:userId           claims exactly one one-time prekey per device
 *
 * Deliberate quirks kept from the real implementation: the directory never claims; a user without
 * keys returns an empty list; the pool drains one key per claim; a device that exhausts its pool
 * still appears in the directory (so senders learn it exists) but with no one-time key.
 */
import type {
  ClaimedBundle,
  ConversationEncryptionStatus,
  DeviceDescriptor,
  E2eeTransport,
} from '../src/lib/e2ee/types';

interface DeviceRecord {
  userId: string;
  deviceId: string;
  algorithm: string;
  identityKey: string;
  signingKey?: string;
  identitySignature?: string;
  registrationId?: number;
  signedPreKey?: { id: number; publicKey: string; signature: string };
  oneTimePreKeys: Array<{ id: number; publicKey: string }>;
}

export interface FakeApiOptions {
  /** Device ids that cannot be reached, to exercise the `unreachable` path. */
  blockedDevices?: string[];
}

export class FakeKeyApi {
  private readonly devices = new Map<string, DeviceRecord>();

  /** Every claim made, so tests can assert that a device with a session does not drain the pool. */
  readonly claims: Array<{ userId: string; deviceId: string; preKeyId: number | null }> = [];

  constructor(private readonly options: FakeApiOptions = {}) {}

  /** Registers a device that speaks another scheme, exactly as a browser client would publish. */
  addForeignDevice(userId: string, deviceId: string, algorithm: string): void {
    this.devices.set(`${userId}:${deviceId}`, {
      userId,
      deviceId,
      algorithm,
      identityKey: 'Zm9yZWlnbi1pZGVudGl0eS1rZXk=',
      oneTimePreKeys: [],
    });
  }

  device(userId: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(`${userId}:${deviceId}`);
  }

  pool(userId: string, deviceId: string): number {
    return this.device(userId, deviceId)?.oneTimePreKeys.length ?? 0;
  }

  /**
   * Drops a device from the directory without touching its keys — models a phone that stopped
   * answering, which the sender must report as unreachable rather than as "user has no devices".
   */
  markBlocked(deviceId: string): void {
    this.options.blockedDevices = [...(this.options.blockedDevices ?? []), deviceId];
  }

  transportFor(userId: string): E2eeTransport {
    const blocked = () => this.options.blockedDevices ?? [];
    return {
      put: async <T,>(path: string, body?: unknown): Promise<T> => {
        const input = (body ?? {}) as Record<string, unknown>;
        if (path === '/api/keys/identity') {
          const deviceId = String(input.deviceId);
          const previous = this.devices.get(`${userId}:${deviceId}`);
          const record: DeviceRecord = {
            userId,
            deviceId,
            algorithm: 'libsignal-v1',
            identityKey: String(input.identityKey),
            registrationId: Number(input.registrationId ?? 1),
            signedPreKey: input.signedPreKey as DeviceRecord['signedPreKey'],
            // The real server merges: keys already in the pool stay, new ones are added.
            oneTimePreKeys: [
              ...(previous?.oneTimePreKeys ?? []),
              ...((input.oneTimePreKeys as DeviceRecord['oneTimePreKeys']) ?? []).map((key) => ({
                id: Number(key.id),
                publicKey: key.publicKey,
              })),
            ],
          };
          this.devices.set(`${userId}:${deviceId}`, record);
          return { deviceId, identityRotated: Boolean(previous), oneTimePreKeysStored: record.oneTimePreKeys.length, algorithm: 'libsignal-v1' } as T;
        }
        throw new Error(`fake_api_unknown_route:${path}`);
      },
      post: async <T,>(path: string, body?: unknown): Promise<T> => {
        const input = (body ?? {}) as Record<string, unknown>;
        if (path === '/api/keys/prekeys') {
          const record = this.devices.get(`${userId}:${String(input.deviceId)}`);
          if (!record) throw new Error('device_unknown');
          const added = ((input.oneTimePreKeys as DeviceRecord['oneTimePreKeys']) ?? []).map((key) => ({
            id: Number(key.id),
            publicKey: key.publicKey,
          }));
          record.oneTimePreKeys.push(...added);
          return { stored: record.oneTimePreKeys.length } as T;
        }
        throw new Error(`fake_api_unknown_route:${path}`);
      },
      get: async <T,>(path: string): Promise<T> => {
        if (path === '/api/keys/me') {
          const devices = [...this.devices.values()]
            .filter((device) => device.userId === userId)
            .map((device) => ({
              deviceId: device.deviceId,
              algorithm: device.algorithm,
              remainingOneTimePreKeys: device.oneTimePreKeys.length,
            }));
          return { devices } as T;
        }
        const directory = /^\/api\/keys\/([^/]+)\/devices$/.exec(path);
        if (directory) {
          const target = directory[1]!;
          const list: DeviceDescriptor[] = [...this.devices.values()]
            .filter((device) => device.userId === target)
            .map((device) => ({
              deviceId: device.deviceId,
              algorithm: device.algorithm,
              identityKey: device.identityKey,
              ...(device.signingKey ? { signingKey: device.signingKey } : {}),
              ...(device.identitySignature ? { identitySignature: device.identitySignature } : {}),
            }));
          return { devices: list } as T;
        }
        const bundles = /^\/api\/keys\/([^/]+)$/.exec(path);
        if (bundles) {
          const target = bundles[1]!;
          const list: ClaimedBundle[] = [...this.devices.values()]
            .filter((device) => device.userId === target)
            .map((device) => {
              const oneTimePreKey = device.oneTimePreKeys.shift() ?? null;
              this.claims.push({ userId: target, deviceId: device.deviceId, preKeyId: oneTimePreKey?.id ?? null });
              const bundle: ClaimedBundle = {
                deviceId: device.deviceId,
                algorithm: device.algorithm,
                identityKey: device.identityKey,
                registrationId: device.registrationId ?? 1,
                // A Signal bundle always carries the signed prekey (the server refuses to publish one
                // without it); the Olm bundle carries a signing key instead, so the field is absent.
                ...(device.signedPreKey
                  ? {
                      signedPreKey: {
                        id: device.signedPreKey.id,
                        publicKey: device.signedPreKey.publicKey,
                        signature: device.signedPreKey.signature,
                      },
                    }
                  : {}),
                ...(oneTimePreKey ? { oneTimePreKey: { id: oneTimePreKey.id, publicKey: oneTimePreKey.publicKey } } : {}),
              };
              if (device.algorithm === 'libsignal-v1' && !device.signedPreKey) {
                throw new Error('bundle_without_signed_prekey');
              }
              return bundle;
            });
          return { bundles: list } as T;
        }
        throw new Error(`fake_api_unknown_route:${path}`);
      },
    };
  }
}

/** A conversation status as the server reports it, for both participants. */
export function conversationStatus(
  participants: Array<{ userId: string }>,
): ConversationEncryptionStatus {
  return {
    isEncrypted: true,
    ready: true,
    participants: participants.map((participant) => ({
      userId: participant.userId,
      ready: true,
      devicesWithKeys: 1,
    })),
  };
}
