import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { AppError, assert } from '../lib/errors.js';
import type { AppDeps, RequestContext } from './context.js';
import type { DomainEvents } from './events.js';
import type { RealtimeHub } from '../realtime/hub.js';

/**
 * Voice/video calling (requirement 2.F).
 *
 * The media path is peer-to-peer WebRTC; this service only performs signalling
 * (call state + participant states) and hands out ICE configuration:
 *  - STUN servers are configurable (default: none — the owner can self-host coturn),
 *  - TURN credentials are generated with the coturn `use-auth-secret` scheme
 *    (HMAC-SHA1 of `<expiry>:<user>` with the shared secret), so the TURN secret
 *    never leaves the server and credentials expire automatically.
 *
 * Group calls / audio spaces return a LiveKit room token when LiveKit is configured;
 * otherwise the API reports `groupCalls: false` and clients must not offer it.
 */

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export class CallsService {
  constructor(
    private readonly deps: AppDeps,
    private readonly realtime: RealtimeHub,
    private readonly events: DomainEvents,
  ) {}

  /** ICE configuration handed to authenticated clients only. */
  iceConfiguration(userId: string): { iceServers: IceServerConfig[] } {
    const cfg = this.deps.cfg;
    const servers: IceServerConfig[] = [];

    for (const url of cfg.RTC_ICE_SERVERS.split(',').map((s) => s.trim()).filter(Boolean)) {
      servers.push({ urls: [url] });
    }
    for (const url of cfg.RTC_TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (cfg.RTC_TURN_SECRET) {
        // Time-limited credentials (RFC-ish coturn convention).
        const ttl = cfg.RTC_TURN_TTL_SECONDS;
        const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
        const credential = createHmac('sha1', cfg.RTC_TURN_SECRET).update(username).digest('base64');
        servers.push({ urls: [url], username, credential });
      } else if (cfg.RTC_TURN_USERNAME && cfg.RTC_TURN_CREDENTIAL) {
        servers.push({ urls: [url], username: cfg.RTC_TURN_USERNAME, credential: cfg.RTC_TURN_CREDENTIAL });
      } else {
        servers.push({ urls: [url] });
      }
    }
    if (servers.length === 0) {
      // A single self-hosted STUN is the sane default; direct connections still work
      // on the same LAN without any ICE server.
      servers.push({ urls: ['stun:stun.l.google.com:19302'] });
    }
    return { iceServers: servers };
  }

  capabilities() {
    const cfg = this.deps.cfg;
    return {
      oneToOneAudio: true,
      oneToOneVideo: true,
      groupCalls: Boolean(cfg.RTC_LIVEKIT_URL && cfg.RTC_LIVEKIT_API_KEY && cfg.RTC_LIVEKIT_API_SECRET),
      audioSpaces: Boolean(cfg.RTC_LIVEKIT_URL),
      turnConfigured: Boolean(cfg.RTC_TURN_URLS && (cfg.RTC_TURN_SECRET || cfg.RTC_TURN_CREDENTIAL)),
      iceServers: cfg.RTC_ICE_SERVERS.split(',').filter(Boolean).length,
    };
  }

  async initiate(userId: string, input: { conversationId: string; kind: 'audio' | 'video' }, ctx: RequestContext) {
    const conversation = await this.deps.repos.conversations.findById(input.conversationId);
    if (!conversation) throw new AppError('conversation_not_found');
    const isMember = await this.deps.repos.conversations.isMember(input.conversationId, userId);
    assert(isMember, 'not_member', 'only_members_can_call');
    if (conversation.type !== 'direct' && !this.capabilities().groupCalls) {
      throw new AppError('service_unavailable', 'group_calls_require_livekit');
    }

    const memberIds = await this.deps.repos.conversations.memberIds(input.conversationId);
    const participants = memberIds.filter((id) => id !== userId);
    assert(participants.length > 0, 'conflict', 'no_other_members_to_call');

    // Do not allow two simultaneous ringing calls in the same conversation.
    const active = await this.deps.db.one<{ id: string }>(
      `select id from calls where conversation_id = $1 and state in ('ringing', 'active') limit 1`,
      [input.conversationId],
    );
    if (active) throw new AppError('conflict', 'call_already_in_progress');

    const call = await this.deps.repos.calls.create({
      conversationId: input.conversationId,
      initiatorId: userId,
      kind: input.kind,
      participantIds: [userId, ...participants],
    });
    await this.deps.repos.calls.markParticipantState(call.id, userId, 'joined');

    const caller = await this.deps.repos.users.findById(userId);
    for (const participantId of participants) {
      await this.deps.repos.notifications.create({
        userId: participantId,
        kind: 'call',
        actorId: userId,
        conversationId: input.conversationId,
        payload: { callId: call.id, kind: input.kind, caller: caller?.username ?? null },
      });
    }
    await this.events.emit({
      type: 'call.incoming',
      callId: call.id,
      conversationId: input.conversationId,
      initiatorId: userId,
      kind: input.kind,
      participantIds: [userId, ...participants],
      at: call.started_at,
    });
    await this.deps.repos.audit.record({
      actorId: userId,
      actorIp: ctx.ip,
      action: 'call.initiated',
      targetType: 'call',
      targetId: call.id,
      metadata: { kind: input.kind, conversationId: input.conversationId },
    });
    return {
      call: this.toDto(call),
      iceServers: this.iceConfiguration(userId).iceServers,
    };
  }

  async answer(userId: string, callId: string) {
    const call = await this.requireParticipant(callId, userId);
    if (call.state === 'ended' || call.state === 'missed' || call.state === 'declined') {
      throw new AppError('conflict', 'call_not_ringing');
    }
    const updated = await this.deps.repos.calls.markAnswered(callId, userId);
    const participants = await this.deps.repos.calls.participants(callId);
    const ids = participants.map((p) => p.user_id);
    await this.events.emit({
      type: 'call.updated',
      callId,
      state: 'active',
      participantIds: ids,
      actorId: userId,
      at: new Date(),
    });
    return { call: this.toDto(updated ?? call), iceServers: this.iceConfiguration(userId).iceServers };
  }

  async decline(userId: string, callId: string) {
    const call = await this.requireParticipant(callId, userId);
    await this.deps.repos.calls.markParticipantState(callId, userId, 'declined');
    const participants = await this.deps.repos.calls.participants(callId);
    const stillInvited = participants.filter((p) => p.state === 'invited' && p.user_id !== userId);
    // If nobody is left to answer and the call never became active, mark it declined.
    const updated =
      call.state === 'ringing' && stillInvited.length === 0
        ? await this.deps.repos.calls.end(callId, userId, 'declined', 'declined_by_peer')
        : call;
    await this.events.emit({
      type: 'call.updated',
      callId,
      state: updated?.state ?? call.state,
      participantIds: participants.map((p) => p.user_id),
      actorId: userId,
      at: new Date(),
    });
    return { call: this.toDto(updated ?? call) };
  }

  async end(userId: string, callId: string, reason = 'ended_by_user') {
    const call = await this.requireParticipant(callId, userId);
    const updated = await this.deps.repos.calls.end(callId, userId, 'ended', reason);
    const participants = await this.deps.repos.calls.participants(callId);
    const ids = participants.map((p) => p.user_id);
    await this.events.emit({ type: 'call.ended', callId, state: 'ended', participantIds: ids, endedBy: userId, reason, at: new Date() });
    await this.deps.repos.audit.record({
      actorId: userId,
      action: 'call.ended',
      targetType: 'call',
      targetId: callId,
      metadata: { reason, durationMs: updated?.duration_ms ?? call.duration_ms ?? 0 },
    });
    return { call: this.toDto(updated ?? call) };
  }

  /**
   * Authorises and relays a WebRTC signalling message (offer/answer/ICE).
   * The server only checks participation and forwards the payload untouched —
   * media and DTLS keys never touch the server.
   */
  async signal(
    userId: string,
    callId: string,
    signal: Extract<import('@sovereign/shared/protocol').ServerFrame, { t: 'call.signal' }>['signal'],
    targetUserId?: string,
  ): Promise<{ delivered: number }> {
    await this.requireParticipant(callId, userId);
    const participants = await this.deps.repos.calls.participants(callId);
    const delivered = await this.realtime.relayCallSignal({
      callId,
      fromUserId: userId,
      participantIds: participants.map((p) => p.user_id),
      targetUserId,
      signal,
    });
    return { delivered };
  }

  async get(userId: string, callId: string) {
    const call = await this.requireParticipant(callId, userId);
    const participants = await this.deps.repos.calls.participants(callId);
    return {
      call: this.toDto(call),
      participants: participants.map((p) => ({
        id: p.user_id,
        username: p.username,
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
        state: p.state,
        joinedAt: p.joined_at ? p.joined_at.toISOString() : null,
        online: this.realtime.isOnline(p.user_id),
      })),
      iceServers: this.iceConfiguration(userId).iceServers,
    };
  }

  async history(userId: string, limit = 50) {
    const rows = await this.deps.repos.calls.history(userId, limit);
    return rows.map((row) => ({ ...this.toDto(row), direction: row.direction, peerUsername: row.peer_username }));
  }

  async ringing(userId: string) {
    const rows = await this.deps.repos.calls.ringingFor(userId);
    return rows.map((row) => ({
      ...this.toDto(row),
      initiatorUsername: row.initiator_username,
      initiatorDisplayName: row.initiator_display_name,
    }));
  }

  /** ------------------------------------------------------------- live rooms */

  async createRoom(userId: string, input: { title: string; topic?: string; kind: 'audio_space' | 'group_call'; visibility: 'public' | 'private' }) {
    if (!this.capabilities().audioSpaces) {
      // Reported honestly instead of pretending the feature works.
      throw new AppError('service_unavailable', 'live_rooms_require_livekit');
    }
    const room = await this.deps.repos.calls.createRoom({
      hostId: userId,
      title: input.title,
      topic: input.topic ?? null,
      kind: input.kind,
      visibility: input.visibility,
    });
    await this.deps.repos.calls.joinRoom(room.id, userId, 'host');
    return {
      room: {
        id: room.id,
        title: room.title,
        topic: room.topic,
        kind: room.kind,
        visibility: room.visibility,
        state: room.state,
        startedAt: room.started_at ? room.started_at.toISOString() : null,
      },
      rtc: await this.livekitToken(userId, `room-${room.id}`, true),
    };
  }

  async joinRoom(userId: string, roomId: string) {
    const room = await this.deps.repos.calls.room(roomId);
    if (!room) throw new AppError('not_found', 'room_not_found');
    if (room.state !== 'live') throw new AppError('conflict', 'room_not_live');
    await this.deps.repos.calls.joinRoom(roomId, userId, 'listener');
    return {
      room: { id: room.id, title: room.title, topic: room.topic, kind: room.kind, state: room.state },
      rtc: await this.livekitToken(userId, `room-${room.id}`, false),
    };
  }

  listRooms(limit = 20) {
    return this.deps.repos.calls.listRooms({ limit, onlyLive: true }).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        topic: row.topic,
        kind: row.kind,
        visibility: row.visibility,
        state: row.state,
        startedAt: row.started_at ? row.started_at.toISOString() : null,
        hostUsername: row.host_username,
        participants: Number(row.participants),
      })),
    );
  }

  /** Issues a LiveKit join token (HS256 JWT with `video` grants). */
  async livekitToken(userId: string, roomName: string, canPublish: boolean) {
    const cfg = this.deps.cfg;
    if (!cfg.RTC_LIVEKIT_URL || !cfg.RTC_LIVEKIT_API_KEY || !cfg.RTC_LIVEKIT_API_SECRET) {
      return null;
    }
    const token = await new SignJWT({
      video: {
        room: roomName,
        roomJoin: true,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(cfg.RTC_LIVEKIT_API_KEY)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode(cfg.RTC_LIVEKIT_API_SECRET));
    return { url: cfg.RTC_LIVEKIT_URL, token, room: roomName };
  }

  private async requireParticipant(callId: string, userId: string) {
    const call = await this.deps.repos.calls.findById(callId);
    if (!call) throw new AppError('not_found', 'call_not_found');
    const participants = await this.deps.repos.calls.participants(callId);
    if (!participants.some((p) => p.user_id === userId)) throw new AppError('forbidden', 'not_a_call_participant');
    return call;
  }

  private toDto(call: {
    id: string;
    conversation_id: string;
    initiator_id: string | null;
    kind: 'audio' | 'video';
    state: string;
    started_at: Date;
    answered_at: Date | null;
    ended_at: Date | null;
    duration_ms: number | null;
    end_reason?: string | null;
  }) {
    return {
      id: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      kind: call.kind,
      state: call.state,
      startedAt: call.started_at.toISOString(),
      answeredAt: call.answered_at ? call.answered_at.toISOString() : null,
      endedAt: call.ended_at ? call.ended_at.toISOString() : null,
      durationMs: call.duration_ms ?? 0,
      endReason: call.end_reason ?? null,
    };
  }
}
