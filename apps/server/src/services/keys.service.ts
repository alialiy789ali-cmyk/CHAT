import { AppError, assert } from '../lib/errors.js';
import type { AppDeps, RequestContext } from './context.js';
import type { DomainEvents } from './events.js';
import type { DeviceKeyBundleInput } from '@sovereign/shared/validation';

/**
 * End-to-end encryption key distribution.
 *
 * Threat model (see docs/security-report.md): the server distributes **public** keys and stores
 * opaque ciphertext. It never receives a private key and cannot derive one, so everything here
 * is about availability, integrity and abuse control of public material:
 *
 *  1. A device publishes its identity key, signed prekey, Kyber prekey and one-time prekeys.
 *  2. A sender requests the recipient's bundle; one one-time prekey is consumed atomically, so
 *     two senders can never reuse the same prekey (the core X3DH promise).
 *  3. Bundles are only served to users the owner's privacy settings allow, and never to a
 *     blocked user.
 *  4. Safety-number verification is stored *per verifier*: my judgement about your device is
 *     mine, and does not silently speak for anyone else.
 *
 * The crypto itself is performed by @signalapp/libsignal-client **on the devices**; this file
 * never imports it. If server code ever needed libsignal to read a message, the design would be
 * wrong — that invariant is enforced by tests (acceptance 22) rather than by convention.
 */

export interface KeyBundleForDevice {
  deviceId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: { id: number; publicKey: string; signature: string };
  kyberPreKey?: { id: number; publicKey: string; signature: string };
  oneTimePreKey?: { id: number; publicKey: string };
}

export class KeysService {
  constructor(
    private readonly deps: AppDeps,
    private readonly events: DomainEvents,
  ) {}

  private assertEnabled(): void {
    assert(this.deps.cfg.E2EE_ENABLED, 'e2ee_not_available', 'e2ee_disabled_on_server');
  }

  private async resolveDevice(userId: string, sessionDeviceId: string | null, requested?: string) {
    const deviceId = requested ?? sessionDeviceId;
    assert(deviceId, 'validation_error', 'device_required');
    const device = await this.deps.repos.sessions.findDevice(deviceId!);
    assert(device && device.user_id === userId, 'not_found', 'device_not_found');
    return device!;
  }

  /** ---------------------------------------------------------------- publication */

  /**
   * Publishes or rotates the calling device's public key material.
   *
   * Re-publishing with the same identity key is the normal path (prekey replenishment); a
   * *different* identity key for the same device means the device was reset, which invalidates
   * every session and every verification, so it is reported back to let clients warn the user.
   */
  async publishIdentity(userId: string, sessionDeviceId: string | null, input: DeviceKeyBundleInput, ctx: RequestContext) {
    this.assertEnabled();
    const device = await this.resolveDevice(userId, sessionDeviceId, input.deviceId);

    const previous = await this.deps.repos.keys.findByDevice(device.id);
    const identityRotated = Boolean(previous && previous.identity_key_public !== input.identityKey);

    const row = await this.deps.repos.keys.publish({
      userId,
      deviceId: device.id,
      identityKeyPublic: input.identityKey,
      signedPrekeyId: input.signedPreKey.id,
      signedPrekeyPublic: input.signedPreKey.publicKey,
      signedPrekeySignature: input.signedPreKey.signature,
      kyberPrekey: input.kyberPreKey
        ? { id: input.kyberPreKey.id, publicKey: input.kyberPreKey.publicKey, signature: input.kyberPreKey.signature }
        : null,
      oneTimePrekeys: input.oneTimePreKeys.map((key: { id: number; publicKey: string }) => ({ id: key.id, key: key.publicKey })),
      registrationId: input.registrationId,
    });

    await this.deps.repos.keys.markUserE2eeReady(userId, true);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'e2ee.keys_published',
      targetType: 'device',
      targetId: device.id,
      metadata: {
        oneTimePreKeys: input.oneTimePreKeys.length,
        identityRotated,
        hasKyberPreKey: Boolean(input.kyberPreKey),
      },
    });

    return {
      deviceId: device.id,
      identityRotated,
      oneTimePreKeysStored: row.one_time_prekeys.length,
      algorithm: row.algorithm,
    };
  }

  /** Adds more one-time prekeys to an existing bundle (clients top up below ~20 remaining). */
  async replenishPreKeys(
    userId: string,
    sessionDeviceId: string | null,
    input: { deviceId?: string; oneTimePreKeys: Array<{ id: number; publicKey: string }> },
    ctx: RequestContext,
  ) {
    this.assertEnabled();
    const device = await this.resolveDevice(userId, sessionDeviceId, input.deviceId);
    const existing = await this.deps.repos.keys.findByDevice(device.id);
    assert(existing, 'not_found', 'identity_not_published');

    const total = await this.deps.repos.keys.appendOneTimePrekeys(
      device.id,
      input.oneTimePreKeys.map((key: { id: number; publicKey: string }) => ({ id: key.id, key: key.publicKey })),
    );
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'e2ee.prekeys_replenished',
      targetType: 'device',
      targetId: device.id,
      metadata: { added: input.oneTimePreKeys.length, total },
    });
    return { deviceId: device.id, oneTimePreKeysStored: total };
  }

  /** Prekey inventory for the caller's own devices (drives the "replenish" prompt). */
  async inventory(userId: string) {
    const devices = await this.deps.repos.keys.inventory(userId);
    return { e2eeEnabled: this.deps.cfg.E2EE_ENABLED, devices };
  }

  /** ---------------------------------------------------------------- distribution */

  /**
   * Returns one bundle per active device of `targetUserId`, consuming one one-time prekey from
   * each. Called by a sender right before establishing a session.
   */
  async bundlesFor(
    targetUserId: string,
    callerId: string,
    ctx: RequestContext,
  ): Promise<{ targetUserId: string; bundles: KeyBundleForDevice[] }> {
    this.assertEnabled();
    const target = await this.deps.repos.users.findById(targetUserId);
    assert(target && target.status === 'active', 'not_found', 'user_not_found');

    if (targetUserId !== callerId) {
      const blocked = await this.deps.repos.social.blockExistsBetween(targetUserId, callerId);
      if (blocked) throw new AppError('forbidden', 'blocked_by_recipient');
      const privacy = target!.privacy_settings as { whoCanMessage?: string } | null;
      // Respect the recipient's messaging privacy: no bundles for people who cannot message.
      if (privacy?.whoCanMessage === 'nobody') throw new AppError('forbidden', 'messaging_disabled_by_recipient');
      if (privacy?.whoCanMessage === 'contacts') {
        const mutual = await this.deps.repos.social.mutualFollow(targetUserId, callerId);
        if (!mutual) throw new AppError('forbidden', 'mutual_follow_required');
      }
    }

    const devices = await this.deps.repos.keys.forUser(targetUserId);
    assert(devices.length > 0, 'not_found', 'no_devices_with_keys');

    const bundles: KeyBundleForDevice[] = [];
    let issuedOneTime = 0;
    for (const device of devices) {
      const oneTime = await this.deps.repos.keys.takeOneTimePrekey(device.device_id);
      const bundle: KeyBundleForDevice = {
        deviceId: device.device_id,
        registrationId: device.registration_id,
        identityKey: device.identity_key_public,
        signedPreKey: {
          id: device.signed_prekey_id,
          publicKey: device.signed_prekey_public,
          signature: device.signed_prekey_signature,
        },
      };
      if (oneTime) {
        bundle.oneTimePreKey = { id: oneTime.id, publicKey: oneTime.key };
        issuedOneTime += 1;
      }
      if (device.kyber_prekey_id !== null && device.kyber_prekey_public && device.kyber_prekey_signature) {
        bundle.kyberPreKey = {
          id: device.kyber_prekey_id,
          publicKey: device.kyber_prekey_public,
          signature: device.kyber_prekey_signature,
        };
      }
      bundles.push(bundle);
    }

    await this.deps.repos.audit.record({
      actorId: callerId,
      actorIp: ctx.ip,
      action: 'e2ee.bundle_fetched',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { devices: bundles.length, oneTimePreKeysIssued: issuedOneTime },
    });

    return { targetUserId, bundles };
  }

  /** ---------------------------------------------------------------- verification */

  /**
   * Records the user's judgement about one device's safety number. Verification is personal:
   * Alice verifying Bob's laptop does not mark it verified for Carol.
   */
  async verifyDevice(
    verifierId: string,
    input: { deviceId: string; fingerprint: string; verified: boolean },
    ctx: RequestContext,
  ) {
    const device = await this.deps.repos.sessions.findDevice(input.deviceId);
    assert(device, 'not_found', 'device_not_found');
    assert(device!.user_id !== verifierId, 'validation_error', 'cannot_verify_own_device');
    const owned = await this.deps.repos.keys.findByDevice(input.deviceId);
    assert(owned, 'not_found', 'device_has_no_keys');

    await this.deps.repos.keys.setVerification({
      verifierId,
      deviceId: input.deviceId,
      fingerprint: input.fingerprint,
      verified: input.verified,
    });
    await this.deps.repos.audit.record({
      actorId: verifierId,
      actorIp: ctx.ip,
      action: input.verified ? 'e2ee.device_verified' : 'e2ee.device_unverified',
      targetType: 'device',
      targetId: input.deviceId,
      metadata: { ownerId: device!.user_id },
    });
    return { deviceId: input.deviceId, verified: input.verified };
  }

  /** Verification state of another user's devices *as seen by the caller*. */
  async verifications(verifierId: string, userId: string) {
    const user = await this.deps.repos.users.findById(userId);
    assert(user, 'not_found', 'user_not_found');
    const devices = await this.deps.repos.keys.verificationsFor(verifierId, userId);
    return {
      userId,
      devices,
      verifiedCount: devices.filter((device) => device.verified).length,
      allVerified: devices.length > 0 && devices.every((device) => device.verified),
    };
  }

  /** ---------------------------------------------------------------- conversation mode */

  /** Encryption status of a conversation plus per-participant key readiness. */
  async encryptionStatus(conversationId: string, viewerId: string) {
    const conversation = await this.deps.repos.conversations.findById(conversationId);
    assert(conversation, 'not_found', 'conversation_not_found');
    await this.requireMembership(conversationId, viewerId);
    const members = await this.deps.repos.conversations.members(conversationId);
    const participants = [];
    for (const member of members) {
      const devices = await this.deps.repos.keys.forUser(member.user_id);
      participants.push({ userId: member.user_id, role: member.role, devicesWithKeys: devices.length, ready: devices.length > 0 });
    }
    return {
      conversationId,
      type: conversation!.type,
      isEncrypted: conversation!.is_encrypted,
      e2eeEnabled: this.deps.cfg.E2EE_ENABLED,
      participants,
      ready: participants.every((participant) => participant.ready),
    };
  }

  /**
   * Enables E2EE for a conversation. Every other member must have published key material
   * first; enabling otherwise would strand messages nobody can decrypt.
   */
  async setConversationEncryption(conversationId: string, userId: string, enabled: boolean, ctx: RequestContext) {
    this.assertEnabled();
    const conversation = await this.deps.repos.conversations.findById(conversationId);
    assert(conversation, 'not_found', 'conversation_not_found');
    await this.requireMembership(conversationId, userId);
    assert(conversation!.type !== 'channel', 'validation_error', 'channels_are_never_encrypted');

    if (enabled) {
      const members = await this.deps.repos.conversations.members(conversationId);
      for (const member of members) {
        const devices = await this.deps.repos.keys.forUser(member.user_id);
        assert(devices.length > 0, 'conflict', `participant_without_keys:${member.user_id}`);
      }
    }

    await this.deps.repos.conversations.setEncrypted(conversationId, enabled);
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: enabled ? 'e2ee.conversation_enabled' : 'e2ee.conversation_disabled',
      targetType: 'conversation',
      targetId: conversationId,
    });

    await this.events.emit({
      type: 'conversation.updated',
      conversationId,
      recipientIds: await this.deps.repos.conversations.memberIds(conversationId),
      reason: enabled ? 'encryption_enabled' : 'encryption_disabled',
      at: new Date(),
    });

    return { conversationId, isEncrypted: enabled };
  }

  private async requireMembership(conversationId: string, userId: string): Promise<void> {
    const member = await this.deps.repos.conversations.member(conversationId, userId);
    if (!member) throw new AppError('not_member', 'not_a_member_of_conversation');
  }
}
