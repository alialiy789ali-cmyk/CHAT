import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  deviceKeyBundleSchema,
  deviceVerificationSchema,
  olmDeviceKeySchema,
  olmReplenishSchema,
  replenishPreKeysSchema,
} from '@sovereign/shared/validation';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';

/**
 * E2EE key distribution endpoints.
 *
 * These carry **public** key material only. A device publishes its keys here, other clients ask
 * for a bundle before starting a session, and users record their safety-number judgements.
 * Message payloads never come through here — they travel as opaque ciphertext in the normal
 * messaging API (see POST /api/conversations/:id/messages).
 */

function ctxOf(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId: request.auth?.userId,
    sessionId: request.auth?.sessionId,
  };
}

export async function registerKeyRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { keys, deps } = container;

  /** The device id of the caller's own session, used as the default publishing target. */
  const sessionDeviceId = async (request: FastifyRequest): Promise<string | null> => {
    const session = await deps.repos.sessions.findSession(request.auth!.sessionId);
    return session?.device_id ?? null;
  };

  app.put('/keys/identity', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const body = deviceKeyBundleSchema.parse(request.body ?? {});
    const result = await keys.publishIdentity(request.auth!.userId, await sessionDeviceId(request), body, ctxOf(request));
    return result;
  });

  app.post('/keys/prekeys', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const body = replenishPreKeysSchema.parse(request.body ?? {});
    return keys.replenishPreKeys(request.auth!.userId, await sessionDeviceId(request), body, ctxOf(request));
  });

  /** Matrix Olm device publication (web client) — Curve25519 identity + Ed25519 signing key. */
  app.put('/keys/identity/olm', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const body = olmDeviceKeySchema.parse(request.body ?? {});
    return keys.publishOlmIdentity(request.auth!.userId, await sessionDeviceId(request), body, ctxOf(request));
  });

  /** Olm one-time key top-up. */
  app.post('/keys/prekeys/olm', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const body = olmReplenishSchema.parse(request.body ?? {});
    return keys.replenishOlmKeys(request.auth!.userId, await sessionDeviceId(request), body, ctxOf(request));
  });

  app.get('/keys/me', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) =>
    keys.inventory(request.auth!.userId),
  );

  /** Bundle lookup: consumes one one-time prekey per device of the target user. */
  app.get('/keys/:userId', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const { userId } = request.params as { userId: string };
    return keys.bundlesFor(userId, request.auth!.userId, ctxOf(request));
  });

  /** Safety-number verification (per verifier). */
  app.post('/keys/verify', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const body = deviceVerificationSchema.parse(request.body ?? {});
    return keys.verifyDevice(request.auth!.userId, body, ctxOf(request));
  });

  app.get('/keys/verify/:userId', { preHandler: [app.authenticate], schema: { tags: ['e2ee'] } }, async (request) => {
    const { userId } = request.params as { userId: string };
    return keys.verifications(request.auth!.userId, userId);
  });
}
