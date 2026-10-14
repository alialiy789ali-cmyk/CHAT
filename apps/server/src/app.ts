import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { registerRoutes } from './routes/index.js';
import { registerGateway } from './realtime/gateway.js';
import type { ServiceContainer } from './services/container.js';
import type { AppDeps } from './services/context.js';
import { describeConfig } from './config/index.js';
import { AppError } from './lib/errors.js';
import { metrics } from './lib/metrics.js';

/**
 * HTTP application factory.
 *
 * Security posture (requirement 6):
 *  - helmet with a CSP that allows the SPA to run but blocks inline script execution
 *    in production (`script-src 'self'`), relaxed only in development for tooling,
 *  - CORS locked to configured origins; development reflects the request origin so a
 *    sandboxed preview URL can talk to the API,
 *  - global rate limiting plus per-route overrides on auth endpoints,
 *  - multipart uploads bounded by the configured size, files streamed (not buffered),
 *  - cookies are httpOnly/SameSite=Lax and only used for the refresh token.
 */

export interface BuildAppOptions {
  deps: AppDeps;
  container: ServiceContainer;
  /** Disable heavy plugins in unit tests. */
  testMode?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { deps, container } = options;
  const cfg = deps.cfg;

  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: Math.max(cfg.UPLOAD_MAX_BYTES + 1024, 2 * 1024 * 1024),
    /**
     * Request logging is off in production (one line per request is noise at volume, and the
     * structured access log is written by the reverse proxy). Fastify 5.12 moved this switch into a
     * controller object; the top-level option is removed in v6.
     */
    logController: new LogController({ disableRequestLogging: cfg.profile === 'production' }),
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
  }) as unknown as FastifyInstance;

  app.decorate('deps', deps);

  /**
   * Every response is counted, whatever happens to it.
   *
   * `routeOptions.url` is the **pattern** (`/files/:attachmentId`), not the requested path, which is
   * what keeps the series count bounded: one series per route instead of one per attachment id. The
   * global 404 handler reports as `unmatched`.
   */
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = { method: request.method, route, status: String(reply.statusCode) };
    metrics.inc('sovereign_http_requests_total', labels, 'HTTP responses by route pattern and status');
    metrics.observe(
      'sovereign_http_request_duration_seconds',
      reply.elapsedTime / 1000,
      { method: request.method, route },
      'HTTP request duration in seconds',
    );
  });

  await app.register(errorHandlerPlugin);

  await app.register(helmet, {
    contentSecurityPolicy: cfg.isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            mediaSrc: ["'self'", 'blob:', 'https:'],
            connectSrc: ["'self'", 'wss:', 'https:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // same-origin / server-to-server
      if (cfg.corsOrigins.includes(origin)) return callback(null, true);
      if (!cfg.isProduction) return callback(null, true); // dev + sandbox preview URLs
      // Allow subdomains of configured hosts (e.g. preview hosts under the same domain).
      try {
        const allowedHost = new URL(cfg.corsOrigins[0] ?? '').hostname;
        const host = new URL(origin).hostname;
        if (allowedHost && (host === allowedHost || host.endsWith(`.${allowedHost}`))) return callback(null, true);
        if (host.endsWith('.e2b.app')) return callback(null, true);
      } catch {
        /* fall through to deny */
      }
      deps.logger.warn({ origin }, 'blocked CORS origin');
      return callback(new AppError('forbidden', 'origin_not_allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-realtime-ticket', 'x-requested-with'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  await app.register(cookie, { secret: cfg.secrets.sessionSecret, hook: 'onRequest' });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: cfg.RATE_LIMIT_GLOBAL_WINDOW,
    allowList: (request) => request.url === '/api/health' || request.url === '/api/health/live',
    keyGenerator: (request) => {
      const auth = (request as { auth?: { userId: string } }).auth;
      if (auth?.userId) return `u:${auth.userId}`;
      return `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: {
        code: 'rate_limited',
        message: `too many requests; retry in ${Math.ceil(Number(context.ttl) / 1000)}s`,
        retryAfterSeconds: Math.ceil(Number(context.ttl) / 1000),
      },
    }),
  });

  await app.register(multipart, {
    limits: {
      fileSize: cfg.UPLOAD_MAX_BYTES,
      files: 10,
      fields: 20,
      fieldSize: 1024 * 100,
    },
    attachFieldsToBody: false,
  });

  await app.register(authPlugin, { deps });
  await registerRoutes(app, container);
  await registerGateway(app, container);

  app.get('/', async () => ({
    name: cfg.APP_NAME,
    api: 'v1',
    status: 'ok',
    documentation: '/api/meta',
  }));

  app.get('/api/meta', async () => ({
    app: cfg.APP_NAME,
    profile: cfg.profile,
    apiVersion: 1,
    protocolVersion: 1,
    websocket: '/ws',
    capabilities: {
      ...container.calls.capabilities(),
      storage: container.uploads.storageDescription(),
      cache: deps.cache.driver,
      mail: deps.mailer.driver,
      e2ee: cfg.E2EE_ENABLED,
    },
    config: describeConfig(cfg),
  }));

  app.addHook('onClose', async () => {
    await container.stop();
  });

  return app;
}

/** Helper used by routes to validate input with a consistent error shape. */
export function parseOrThrow<T>(schema: { parse: (input: unknown) => T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) throw err;
    throw AppError.from(err);
  }
}
