import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServiceContainer } from '../services/container.js';
import { clientIp, type RequestContext } from '../services/context.js';
import { ALLOWED_MIME_TYPES } from '../services/uploads.service.js';

function ctxOf(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: String(request.id),
    userId: request.auth?.userId,
  };
}

/** Upload, download and delete files. Downloads always require authorisation. */
export async function registerFileRoutes(app: FastifyInstance, container: ServiceContainer): Promise<void> {
  const { uploads } = container;

  app.get('/files/allowed-types', { schema: { tags: ['files'] } }, async () => ALLOWED_MIME_TYPES);

  app.post('/files', { preHandler: [app.authenticate], schema: { tags: ['files'] } }, async (request, reply) => {
    const file = await request.file({
      limits: { fileSize: container.deps.cfg.UPLOAD_MAX_BYTES, files: 1 },
    });
    if (!file) {
      reply.status(400).send({ error: { code: 'validation_error', message: 'file_part_required' } });
      return;
    }
    const durationHeader = file.fields?.durationMs;
    const durationMs =
      durationHeader && typeof durationHeader === 'object' && 'value' in durationHeader
        ? Number((durationHeader as { value: unknown }).value)
        : null;

    const attachment = await uploads.upload(
      request.auth!.userId,
      {
        fileName: file.filename,
        mimeType: file.mimetype,
        data: file.file,
        durationMs: Number.isFinite(durationMs as number) ? (durationMs as number) : null,
      },
      ctxOf(request),
    );
    reply.status(201);
    return { attachment };
  });

  /**
   * Downloads accept three credentials, all session-checked:
   *   1. `Authorization: Bearer <access token>` — API clients and the mobile app.
   *   2. `?token=<media token>`                  — <img>/<video>/<a download> in the browser.
   *   3. `?access_token=<access token>`          — GET-only fallback for same-origin tags.
   * Authorisation is unchanged in every case: the file must be visible to the caller.
   */
  app.get('/files/:attachmentId', { preHandler: [app.authenticateMedia], schema: { tags: ['files'] } }, async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    const file = await uploads.download(attachmentId, request.auth!.userId);

    reply.header('content-type', file.mimeType);
    reply.header('content-length', String(file.sizeBytes));
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    // Inline only for safe media types; everything else downloads.
    const inline = /^(image\/(jpeg|png|webp|gif|avif)|video\/|audio\/|application\/pdf)/.test(file.mimeType);
    reply.header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.fileName)}"`,
    );

    const body = Readable.from(file.stream as unknown as AsyncIterable<Buffer>);
    return reply.send(body);
  });

  app.delete('/files/:attachmentId', { preHandler: [app.authenticate], schema: { tags: ['files'] } }, async (request) => {
    const { attachmentId } = request.params as { attachmentId: string };
    await uploads.deleteUpload(attachmentId, request.auth!.userId);
    return { deleted: true };
  });

  app.get('/files/usage', { preHandler: [app.authenticate], schema: { tags: ['files'] } }, async (request) =>
    uploads.usage(request.auth!.userId),
  );

  void pipeline;
}
