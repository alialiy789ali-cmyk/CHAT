import type { FastifyInstance } from 'fastify';
import type { ServiceContainer } from '../services/container.js';
import { registerHealthRoutes } from './health.js';
import { registerAuthRoutes } from './auth.routes.js';
import { registerUserRoutes } from './users.routes.js';
import { registerMessagingRoutes } from './messaging.routes.js';
import { registerFileRoutes } from './files.routes.js';
import { registerSocialRoutes } from './social.routes.js';
import { registerChannelRoutes } from './channels.routes.js';
import { registerCallRoutes } from './calls.routes.js';
import { registerKeyRoutes } from './keys.routes.js';
import { registerModerationRoutes } from './moderation.routes.js';
import { registerMetricsRoutes } from './metrics.routes.js';

/** Every route is registered under /api and tagged for the generated documentation. */
export async function registerRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  await app.register(
    async (api) => {
      await registerHealthRoutes(api, container);
      await registerAuthRoutes(api, container);
      await registerUserRoutes(api, container);
      await registerMessagingRoutes(api, container);
      await registerFileRoutes(api, container);
      await registerSocialRoutes(api, container);
      await registerChannelRoutes(api, container);
      await registerCallRoutes(api, container);
      await registerKeyRoutes(api, container);
      await registerModerationRoutes(api, container);
      await registerMetricsRoutes(api, container);
    },
    { prefix: '/api' },
  );
}
