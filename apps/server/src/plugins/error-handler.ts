import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Central error handling.
 *
 * - `AppError` instances expose a stable code + safe message,
 * - zod failures become `validation_error` with the failing paths only,
 * - everything else becomes `internal_error` with a request id and *no* stack trace,
 * - 5xx responses are logged with full context (headers are redacted by the logger),
 * - 4xx client mistakes are logged at warn level without noise.
 */

export default fp(
  async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      if (error instanceof ZodError) {
        const details = error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        }));
        reply.status(400).send({ error: { code: 'validation_error', message: 'invalid_request', details, requestId } });
        return;
      }

      if (error instanceof AppError) {
        if (error.statusCode >= 500) {
          request.log.error({ err: error, requestId }, 'request failed');
        } else {
          request.log.warn(
            { code: error.code, requestId, path: request.url, method: request.method },
            'request rejected',
          );
        }
        reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details, requestId },
        });
        return;
      }

      // Plugin errors (@fastify/rate-limit and friends) may throw a plain object that
      // carries its own status code and response payload. Honour it instead of 500-ing.
      const carrier = error as unknown as { statusCode?: number; error?: { code?: string; message?: string } };
      if (!(error instanceof Error) && carrier && typeof carrier === 'object' && typeof carrier.statusCode === 'number') {
        const { statusCode, ...payload } = carrier as { statusCode: number } & Record<string, unknown>;
        request.log.warn({ requestId, statusCode, path: request.url }, 'request rejected by plugin');
        reply.status(statusCode).send({ ...payload, requestId });
        return;
      }

      // Fastify-native errors (body too large, unsupported media type, ...) keep their status.
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        reply.status(status).send({
          error: {
            code: status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'validation_error',
            message: error.message,
            requestId,
          },
        });
        return;
      }

      const appError = AppError.from(error);
      request.log.error({ err: error, requestId }, 'unhandled error');
      reply.status(appError.statusCode).send({
        error: { code: appError.code, message: 'internal_error', requestId },
      });
    });

    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      reply.status(404).send({
        error: { code: 'not_found', message: `route_not_found: ${request.method} ${request.url}`, requestId: request.id },
      });
    });
  },
  { name: 'sovereign-error-handler' },
);
