'use client';

/**
 * Security centre for one conversation.
 *
 * Three things a user can actually act on, and nothing decorative:
 *   1. whether the conversation is encrypted, and a switch that only works when every member has
 *      published keys (otherwise the server refuses, and the UI explains why);
 *   2. every device of every member with its fingerprint, so a changed key is visible;
 *   3. the safety number for a device, with a way to record that it was compared out loud.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Modal, Spinner } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import { useE2ee } from '@/lib/e2ee/context';
import { deviceFingerprint, safetyNumber, safetyNumberEmoji } from '@/lib/e2ee/fingerprint';
import type { ConversationEncryptionStatus, PeerDeviceVerification } from '@/lib/e2ee/types';

interface ParticipantDevice {
  userId: string;
  displayName: string;
  deviceId: string;
  algorithm: string;
  identityKey: string | null;
  fingerprint: string | null;
  verified: boolean;
  mine: boolean;
}

export function SecurityPanel({
  open,
  onClose,
  conversationId,
  conversationTitle,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  conversationTitle: string;
}) {
  const tr = useT();
  const { engine, status, error } = useE2ee();
  const [conversation, setConversation] = useState<ConversationEncryptionStatus | null>(null);
  const [devices, setDevices] = useState<ParticipantDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ParticipantDevice | null>(null);

  const load = useCallback(async () => {
    if (!engine) return;
    setLoading(true);
    setNotice(null);
    try {
      const status = await engine.conversationStatus(conversationId);
      setConversation(status);

      // Real display names come from the conversation itself; the encryption endpoint only
      // reports ids and readiness.
      const detail = await api.get<{ conversation: { members: Array<{ userId: string; displayName: string }> } }>(
        `/api/conversations/${conversationId}`,
      );
      const nameByUser = new Map(detail.conversation.members.map((member) => [member.userId, member.displayName]));
      const members = status.participants.map((participant) => participant.userId);
      const collected: ParticipantDevice[] = [];
      for (const userId of members) {
        const [bundles, verifications] = await Promise.all([
          engine.peerDevices(userId).catch(() => []),
          engine.verificationsFor(userId).catch(() => [] as PeerDeviceVerification[]),
        ]);
        const verificationByDevice = new Map(verifications.map((entry) => [entry.deviceId, entry]));
        for (const bundle of bundles) {
          const verification = verificationByDevice.get(bundle.deviceId);
          const identityKey = bundle.identityKey;
          collected.push({
            userId,
            displayName: userId === engine.userId ? tr('myDevices') : nameByUser.get(userId) ?? userId.slice(0, 8),
            deviceId: bundle.deviceId,
            algorithm: bundle.algorithm,
            identityKey,
            fingerprint: verification?.fingerprint ?? (identityKey ? await deviceFingerprint(identityKey) : null),
            verified: verification?.verified ?? false,
            mine: userId === engine.userId,
          });
        }
      }
      setDevices(collected);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, [conversationId, engine, tr]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function toggleEncryption(next: boolean) {
    if (!engine) return;
    setBusy(true);
    try {
      await engine.setConversationEncryption(conversationId, next);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function toggleVerified(device: ParticipantDevice) {
    if (!engine || !device.fingerprint) return;
    setBusy(true);
    try {
      await engine.markVerified(device.deviceId, device.fingerprint, !device.verified);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const ready = conversation?.ready ?? false;
  const encrypted = conversation?.isEncrypted ?? false;

  return (
    <Modal open={open} onClose={onClose} title={`${tr('securityCenter')} — ${conversationTitle}`}>
      {!engine ? (
        <p className="text-sm" role="status">
          {error === 'e2ee_unsupported_browser' ? tr('e2eeUnsupported') : error ?? tr('connecting')}
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">{tr('encryption')}</span>
              {encrypted ? <Badge tone="success">{tr('encrypted')}</Badge> : <Badge>{tr('notEncrypted')}</Badge>}
            </div>
            <p className="muted text-xs">{ready ? tr('encryptionReady') : tr('encryptionNotReady')}</p>
            <Button
              variant={encrypted ? 'ghost' : 'primary'}
              disabled={busy || (!ready && !encrypted)}
              onClick={() => void toggleEncryption(!encrypted)}
            >
              {encrypted ? tr('disableEncryption') : tr('enableEncryption')}
            </Button>
            {status && (
              <p className="muted text-xs">
                {tr('deviceKeysPublished')} · {status.oneTimeKeysRemaining} {tr('oneTimeKeysLeft')}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">{tr('verifyingDevice')}</h3>
            {loading ? (
              <div className="grid place-items-center p-4">
                <Spinner />
              </div>
            ) : devices.length === 0 ? (
              <p className="muted text-xs">{tr('encryptionNotReady')}</p>
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {devices.map((device) => (
                  <li key={device.deviceId} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">
                        {device.mine ? tr('myDevices') : device.displayName} · {device.algorithm}
                      </p>
                      <p className="muted truncate font-mono text-[10px]">{device.fingerprint ?? '—'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {device.verified ? <Badge tone="success">{tr('verified')}</Badge> : <Badge>{tr('unverified')}</Badge>}
                      {!device.mine && (
                        <>
                          <Button variant="ghost" onClick={() => setSelected(device)}>
                            {tr('safetyNumber')}
                          </Button>
                          <Button variant="ghost" disabled={busy} onClick={() => void toggleVerified(device)}>
                            {device.verified ? tr('markUnverified') : tr('markVerified')}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {notice && (
            <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">
              {notice}
            </p>
          )}
          <p className="muted text-xs">{tr('e2eeNotice')}</p>
        </div>
      )}

      {selected && engine && selected.identityKey && (
        <SafetyNumberDialog
          device={selected}
          ownIdentityKey={engine.identityKey}
          onClose={() => setSelected(null)}
          onVerified={async () => {
            if (selected) await toggleVerified({ ...selected, verified: true });
            setSelected(null);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * The safety number itself.
 *
 * Both sides derive it from the two identity keys, so it can be compared over any other channel
 * with no extra protocol steps. If the server handed out its own key to either side, the digit
 * groups differ and the comparison fails — which is the whole point of doing it out loud.
 */
function SafetyNumberDialog({
  device,
  ownIdentityKey,
  onClose,
  onVerified,
}: {
  device: ParticipantDevice;
  ownIdentityKey: string;
  onClose: () => void;
  onVerified: () => Promise<void>;
}) {
  const tr = useT();
  const [groups, setGroups] = useState<string[] | null>(null);
  const [emoji, setEmoji] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!device.identityKey) return;
      const [digits, symbols] = await Promise.all([
        safetyNumber(ownIdentityKey, device.identityKey),
        safetyNumberEmoji(ownIdentityKey, device.identityKey),
      ]);
      if (!cancelled) {
        setGroups(digits);
        setEmoji(symbols);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device.identityKey, ownIdentityKey]);

  return (
    <Modal open title={tr('safetyNumber')} onClose={onClose}>
      <div className="space-y-3">
        <p className="muted text-xs">{tr('safetyNumberHelp')}</p>
        {groups ? (
          <div className="grid grid-cols-3 gap-2 text-center" dir="ltr">
            {groups.map((group, index) => (
              <span key={index} className="rounded-lg px-2 py-1 font-mono text-base" style={{ background: 'var(--surface-sunken)' }}>
                {group}
              </span>
            ))}
          </div>
        ) : (
          <div className="grid place-items-center p-4">
            <Spinner />
          </div>
        )}
        {emoji && (
          <p className="text-center text-2xl" aria-label={tr('safetyNumber')}>
            {emoji.join(' ')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
          <Button variant="primary" onClick={() => void onVerified()}>
            {tr('markVerified')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
