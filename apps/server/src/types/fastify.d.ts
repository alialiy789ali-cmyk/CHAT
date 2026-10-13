/**
 * Route schema extensions used for documentation metadata (tags/summary).
 * `import 'fastify'` makes this a module augmentation rather than an ambient
 * module declaration that would shadow the real package types.
 */
import 'fastify';

declare module 'fastify' {
  interface FastifySchema {
    tags?: string[];
    summary?: string;
    description?: string;
    operationId?: string;
  }
}
