'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { realtime, newRequestId } from '@/lib/realtime';
import { Button, Spinner } from '@/components/ui';
import { useT } from '@/lib/i18n';

/**
 * WebRTC calling.
 *
 * The server authorises calls and relays opaque SDP/ICE payloads over the authenticated
 * socket (`call.signal` frames, must be a participant — enforced server-side). Media flows
 * peer-to-peer; when a direct path is impossible the browser falls back to the self-hosted
 * TURN server, whose credentials are time-limited and issued per authenticated request.
 */

export interface CallState {
  callId: string | null;
  status: 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended' | 'failed';
  kind: 'audio' | 'video';
  peer: { id: string; username: string; displayName: string } | null;
  conversationId: string | null;
  error: string | null;
  durationSeconds: number;
  muted: boolean;
  cameraOff: boolean;
  iceState: RTCIceConnectionState | null;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function useCall() {
  const [state, setState] = useState<CallState>({
    callId: null,
    status: 'idle',
    kind: 'audio',
    peer: null,
    conversationId: null,
    error: null,
    durationSeconds: 0,
    muted: false,
    cameraOff: false,
    iceState: null,
  });

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSet = useRef(false);
  const timerRef = useRef<number | null>(null);
  const callIdRef = useRef<string | null>(null);
  const incomingOffer = useRef<{ callId: string; sdp: string } | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  }, []);

  const teardown = useCallback(
    (status: CallState['status'], error: string | null = null) => {
      peerRef.current?.close();
      peerRef.current = null;
      remoteDescriptionSet.current = false;
      pendingCandidates.current = [];
      incomingOffer.current = null;
      stopMedia();
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      callIdRef.current = null;
      setState((current) => ({ ...current, status, error, callId: null, durationSeconds: 0, muted: false, cameraOff: false }));
    },
    [stopMedia],
  );

  const attachRemote = useCallback(() => {
    if (remoteVideoRef.current && remoteStreamRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
    if (remoteAudioRef.current && remoteStreamRef.current) remoteAudioRef.current.srcObject = remoteStreamRef.current;
  }, []);

  const buildPeer = useCallback(
    async (callId: string, kind: 'audio' | 'video', withMedia: boolean) => {
      const { iceServers } = await api.get<{ iceServers: IceServer[] }>('/api/calls/ice');
      const peer = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
      peerRef.current = peer;

      remoteStreamRef.current = new MediaStream();
      peer.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remoteStreamRef.current?.addTrack(track));
        attachRemote();
      };
      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        realtime.send({
          t: 'call.signal',
          rid: newRequestId('ice'),
          callId,
          signal: { type: 'candidate', candidate: event.candidate.toJSON() },
        });
      };
      peer.oniceconnectionstatechange = () => {
        setState((current) => ({ ...current, iceState: peer.iceConnectionState }));
        if (peer.iceConnectionState === 'failed') {
          setState((current) => ({ ...current, error: 'فشل الاتصال المباشر — تأكد من إعداد TURN للشبكات المقيّدة.' }));
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') {
          setState((current) => (current.status === 'active' ? current : { ...current, status: 'active' }));
          if (!timerRef.current) {
            timerRef.current = window.setInterval(
              () => setState((current) => ({ ...current, durationSeconds: current.durationSeconds + 1 })),
              1000,
            );
          }
        }
        if (peer.connectionState === 'failed') {
          setState((current) => ({ ...current, status: 'failed', error: 'انقطع الاتصال.' }));
        }
      };

      if (withMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
        });
        localStreamRef.current = stream;
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      }
      return peer;
    },
    [attachRemote],
  );

  const applySignal = useCallback(
    async (signal: { type: string; sdp?: string; candidate?: unknown }) => {
      if (signal.type === 'offer' && signal.sdp) {
        // Remember the offer: the media is acquired only when the user answers.
        incomingOffer.current = { callId: callIdRef.current ?? '', sdp: signal.sdp };
        return;
      }
      if (signal.type === 'bye') {
        teardown('ended');
        return;
      }
      const peer = peerRef.current;
      if (!peer) return;
      if (signal.type === 'answer' && signal.sdp) {
        await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        remoteDescriptionSet.current = true;
        for (const candidate of pendingCandidates.current.splice(0)) await peer.addIceCandidate(candidate).catch(() => {});
        return;
      }
      if (signal.type === 'candidate' && signal.candidate) {
        const candidate = signal.candidate as RTCIceCandidateInit;
        if (!remoteDescriptionSet.current) pendingCandidates.current.push(candidate);
        else await peer.addIceCandidate(candidate).catch(() => {});
      }
    },
    [teardown],
  );

  /** Applies the pending offer once the local peer connection exists (callee side). */
  const drainIncomingOffer = useCallback(async () => {
    const peer = peerRef.current;
    const offer = incomingOffer.current;
    if (!peer || !offer) return;
    await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    remoteDescriptionSet.current = true;
    for (const candidate of pendingCandidates.current.splice(0)) await peer.addIceCandidate(candidate).catch(() => {});
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    realtime.send({
      t: 'call.signal',
      rid: newRequestId('ans'),
      callId: offer.callId,
      signal: { type: 'answer', sdp: answer.sdp ?? '' },
    });
    incomingOffer.current = null;
  }, []);

  // Socket wiring: incoming call notifications + signalling payloads + call state changes.
  useEffect(() => {
    const subscription = realtime.onFrame((frame) => {
      if (frame.t === 'call.signal') {
        void applySignal(frame.signal as { type: string; sdp?: string; candidate?: unknown });
        return;
      }
      if (frame.t !== 'notification') return;
      if (frame.kind === 'call.incoming') {
        const payload = frame.payload as { callId: string; conversationId: string; initiatorId: string; kind: 'audio' | 'video' };
        callIdRef.current = payload.callId;
        setState((current) => ({
          ...current,
          callId: payload.callId,
          conversationId: payload.conversationId,
          status: 'incoming',
          kind: payload.kind,
          peer: current.peer,
          error: null,
        }));
        // Resolve the caller's display name from the conversation (no peer data in the frame).
        void api
          .get<{ id: string; title: string | null; peerUsername: string | null }>(`/api/conversations/${payload.conversationId}`)
          .then((conversation) =>
            setState((current) => ({
              ...current,
              peer: {
                id: payload.initiatorId,
                username: conversation.peerUsername ?? '',
                displayName: conversation.title ?? 'مكالمة واردة',
              },
            })),
          )
          .catch(() => {});
        return;
      }
      if (frame.kind === 'call.updated') {
        const payload = frame.payload as { state: string };
        if (payload.state === 'active') setState((current) => ({ ...current, status: 'active' }));
        if (payload.state === 'ended' || payload.state === 'declined' || payload.state === 'missed') teardown('ended');
        return;
      }
      if (frame.kind === 'call.ended') teardown('ended');
    });
    return () => {
      subscription();
    };
  }, [applySignal, teardown]);

  /** Starts an outgoing call in a direct conversation. */
  const start = useCallback(
    async (conversationId: string, kind: 'audio' | 'video') => {
      setState((current) => ({ ...current, status: 'outgoing', kind, conversationId, error: null }));
      try {
        const created = await api.post<{ call: { id: string }; iceServers: IceServer[] }>('/api/calls', { conversationId, kind });
        callIdRef.current = created.call.id;
        setState((current) => ({ ...current, callId: created.call.id, status: 'connecting' }));
        const peer = await buildPeer(created.call.id, kind, true);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        realtime.send({
          t: 'call.signal',
          rid: newRequestId('off'),
          callId: created.call.id,
          signal: { type: 'offer', sdp: offer.sdp ?? '' },
        });
      } catch (err) {
        setState((current) => ({
          ...current,
          status: 'failed',
          error: err instanceof Error && err.message === 'conflict' ? 'هناك مكالمة جارية بالفعل' : 'تعذّر بدء المكالمة.',
        }));
      }
    },
    [buildPeer],
  );

  /** Accepts an incoming call: acquires media, answers, then applies the pending offer. */
  const answer = useCallback(async () => {
    const callId = callIdRef.current;
    if (!callId) return;
    setState((current) => ({ ...current, status: 'connecting' }));
    try {
      await api.post(`/api/calls/${callId}/answer`);
      await buildPeer(callId, state.kind, true);
      await drainIncomingOffer();
    } catch {
      setState((current) => ({ ...current, status: 'failed', error: 'تعذّر الوصول إلى الميكروفون/الكاميرا.' }));
    }
  }, [buildPeer, drainIncomingOffer, state.kind]);

  const decline = useCallback(async () => {
    const callId = callIdRef.current;
    if (callId) await api.post(`/api/calls/${callId}/decline`).catch(() => {});
    teardown('ended');
  }, [teardown]);

  const hangUp = useCallback(async () => {
    const callId = callIdRef.current;
    if (callId) {
      realtime.send({ t: 'call.signal', rid: newRequestId('bye'), callId, signal: { type: 'bye' } });
      await api.post(`/api/calls/${callId}/end`).catch(() => {});
    }
    teardown('ended');
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    const nextMuted = !state.muted;
    tracks.forEach((track) => (track.enabled = !nextMuted));
    setState((current) => ({ ...current, muted: nextMuted }));
  }, [state.muted]);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks() ?? [];
    const nextOff = !state.cameraOff;
    tracks.forEach((track) => (track.enabled = !nextOff));
    setState((current) => ({ ...current, cameraOff: nextOff }));
  }, [state.cameraOff]);

  return {
    ...state,
    start,
    answer,
    decline,
    hangUp,
    toggleMute,
    toggleCamera,
    attachRemote,
    localVideoRef,
    remoteVideoRef,
    remoteAudioRef,
  };
}

export type CallControls = ReturnType<typeof useCall>;

export function CallOverlay({ call, title }: { call: CallControls; title: string }) {
  const tr = useT();
  const visible = call.status !== 'idle' && call.status !== 'ended';
  const { attachRemote } = call;

  useEffect(() => {
    if (visible) attachRemote();
  }, [visible, attachRemote]);

  if (!visible) return null;

  const label =
    call.status === 'incoming'
      ? `${call.peer?.displayName ?? title} · ${call.kind === 'video' ? tr('videoCall') : tr('audioCall')}`
      : call.status === 'outgoing' || call.status === 'connecting'
        ? tr('ringing')
        : `${String(Math.floor(call.durationSeconds / 60)).padStart(2, '0')}:${String(call.durationSeconds % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-3xl p-3" role="dialog" aria-label="call">
      <div className="card space-y-3 p-4 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate font-semibold">{call.peer?.displayName ?? title}</p>
            <p className="muted truncate text-xs">
              {label}
              {call.iceState && ` · ICE: ${call.iceState}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {call.status === 'incoming' ? (
              <>
                <Button onClick={() => void call.answer()}>✅ {tr('answer')}</Button>
                <Button variant="danger" onClick={() => void call.decline()}>
                  {tr('decline')}
                </Button>
              </>
            ) : (
              <>
                {call.status === 'active' && (
                  <>
                    <Button variant="ghost" onClick={call.toggleMute} aria-pressed={call.muted}>
                      {call.muted ? '🔇' : '🎤'} {call.muted ? tr('unmute') : tr('mute')}
                    </Button>
                    {call.kind === 'video' && (
                      <Button variant="ghost" onClick={call.toggleCamera} aria-pressed={call.cameraOff}>
                        {call.cameraOff ? '🎥' : '📷'} {call.cameraOff ? tr('cameraOn') : tr('cameraOff')}
                      </Button>
                    )}
                  </>
                )}
                {call.status === 'outgoing' && <Spinner size={16} />}
                <Button variant="danger" onClick={() => void call.hangUp()}>
                  {tr('hangUp')}
                </Button>
              </>
            )}
          </div>
        </div>

        {call.error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">
            {call.error}
          </p>
        )}

        {call.kind === 'video' && (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video ref={call.remoteVideoRef} autoPlay playsInline className="h-56 w-full object-contain" />
            <video
              ref={call.localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-2 end-2 h-24 w-32 rounded-lg border-2 border-white/40 object-cover"
            />
          </div>
        )}
        {/* Remote audio must always be mounted, even for audio-only calls. */}
        <audio ref={call.remoteAudioRef} autoPlay />
      </div>
    </div>
  );
}
