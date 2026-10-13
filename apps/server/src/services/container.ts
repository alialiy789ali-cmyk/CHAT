import type { AppDeps } from './context.js';
import { AuthService } from './auth.service.js';
import { UsersService } from './users.service.js';
import { MessagingService } from './messaging.service.js';
import { ChannelsService } from './channels.service.js';
import { SocialService } from './social.service.js';
import { UploadsService } from './uploads.service.js';
import { ModerationService } from './moderation.service.js';
import { CallsService } from './calls.service.js';
import { KeysService } from './keys.service.js';
import { RealtimeHub } from '../realtime/hub.js';
import { DomainEvents } from './events.js';

/**
 * Composition root. Services receive their dependencies explicitly (constructor
 * injection) which keeps them testable in isolation without a DI framework.
 */
export class ServiceContainer {
  readonly auth: AuthService;
  readonly users: UsersService;
  readonly messaging: MessagingService;
  readonly channels: ChannelsService;
  readonly social: SocialService;
  readonly uploads: UploadsService;
  readonly moderation: ModerationService;
  readonly calls: CallsService;
  readonly keys: KeysService;
  readonly events: DomainEvents;
  readonly realtime: RealtimeHub;

  constructor(readonly deps: AppDeps) {
    this.events = new DomainEvents();
    this.realtime = new RealtimeHub(deps, this.events);
    this.users = new UsersService(deps);
    this.auth = new AuthService(deps);
    this.messaging = new MessagingService(deps, this.realtime, this.events);
    this.channels = new ChannelsService(deps, this.realtime, this.events);
    this.social = new SocialService(deps, this.events);
    this.uploads = new UploadsService(deps);
    this.moderation = new ModerationService(deps);
    this.calls = new CallsService(deps, this.realtime, this.events);
    this.keys = new KeysService(deps, this.events);
  }

  async start(): Promise<void> {
    await this.realtime.start();
  }

  async stop(): Promise<void> {
    if (process.env.SOVEREIGN_TRACE_CLOSE === 'true') console.log('[container] stopping realtime hub');
    await this.realtime.stop();
    if (process.env.SOVEREIGN_TRACE_CLOSE === 'true') console.log('[container] realtime hub stopped');
  }
}
