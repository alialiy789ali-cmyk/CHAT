import { createReadStream, existsSync, mkdirSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { absolutePath, type AppConfig } from '../config/index.js';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Object storage abstraction.
 *
 * Local development/tests: content-addressed files under `apps/server/var/storage`
 * (no external service). Production: any S3-compatible service — MinIO self-hosted
 * by default (see infra/docker-compose.yml), or any other S3 endpoint the owner
 * chooses. Keys are always content-addressed by SHA-256, which gives us
 * deduplication and integrity verification for free.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

export interface Storage {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer | Readable, contentType: string): Promise<StoredObject>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Human-readable storage location for the ops/deployment documentation. */
  describe(): string;
}

export function contentKey(sha256: string, ext: string): string {
  const cleanExt = ext.replace(/[^a-z0-9.]/gi, '').slice(0, 12);
  return `objects/${sha256.slice(0, 2)}/${sha256}${cleanExt}`;
}

export class LocalStorage implements Storage {
  readonly driver = 'local' as const;
  private readonly dir: string;

  constructor(cfg: AppConfig) {
    this.dir = absolutePath(cfg, cfg.STORAGE_LOCAL_DIR);
    mkdirSync(this.dir, { recursive: true });
  }

  private fullPath(key: string): string {
    const resolved = path.resolve(this.dir, key);
    if (!resolved.startsWith(path.resolve(this.dir))) {
      throw new AppError('storage_error', 'path_traversal_blocked');
    }
    return resolved;
  }

  async put(key: string, data: Buffer | Readable, contentType: string): Promise<StoredObject> {
    const target = this.fullPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    let size = 0;
    if (Buffer.isBuffer(data)) {
      hash.update(data);
      await fs.writeFile(target, data);
      size = data.byteLength;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
        hash.update(buf);
        size += buf.byteLength;
        chunks.push(buf);
      }
      await fs.writeFile(target, Buffer.concat(chunks));
    }
    return { key, sizeBytes: size, sha256: hash.digest('hex'), mimeType: contentType };
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.fullPath(key);
    if (!existsSync(target)) throw new AppError('not_found', 'file_missing');
    return createReadStream(target);
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.fullPath(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.fullPath(key), { force: true });
  }

  size(key: string): number {
    try {
      return statSync(this.fullPath(key)).size;
    } catch {
      return 0;
    }
  }

  describe(): string {
    return `local filesystem (${this.dir})`;
  }
}

/**
 * S3/MinIO driver. Uses the AWS SDK v3 style REST API through a thin fetch client
 * with SigV4 signing, so the server keeps a small dependency surface and works with
 * any S3-compatible endpoint (MinIO, Ceph, SeaweedFS, Garage, AWS S3).
 */
export class S3Storage implements Storage {
  readonly driver = 's3' as const;
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly forcePathStyle: boolean;

  constructor(
    cfg: AppConfig,
    private readonly logger: Logger,
  ) {
    if (!cfg.S3_ACCESS_KEY || !cfg.S3_SECRET_KEY) {
      throw new AppError('storage_error', 's3_credentials_missing');
    }
    this.endpoint = cfg.S3_ENDPOINT.replace(/\/$/, '');
    this.bucket = cfg.S3_BUCKET;
    this.region = cfg.S3_REGION;
    this.accessKey = cfg.S3_ACCESS_KEY;
    this.secretKey = cfg.S3_SECRET_KEY;
    this.forcePathStyle = cfg.S3_FORCE_PATH_STYLE;
  }

  private objectUrl(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return this.forcePathStyle
      ? `${this.endpoint}/${this.bucket}/${encoded}`
      : `${this.endpoint.replace('://', `://${this.bucket}.`)}/${encoded}`;
  }

  private async sign(method: string, url: string, payloadHash: string, extraHeaders: Record<string, string> = {}) {
    const { signAwsRequest } = await import('./sigv4.js');
    return signAwsRequest({
      method,
      url,
      payloadHash,
      region: this.region,
      service: 's3',
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      extraHeaders,
    });
  }

  async put(key: string, data: Buffer | Readable, contentType: string): Promise<StoredObject> {
    const { createHash } = await import('node:crypto');
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.concat(
          await (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of data) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
            return chunks;
          })(),
        );
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const url = this.objectUrl(key);
    const headers = await this.sign('PUT', url, sha256, {
      'content-type': contentType,
      'content-length': String(buffer.byteLength),
      'x-amz-content-sha256': sha256,
    });
    const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(buffer) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error({ status: res.status, body: body.slice(0, 300) }, 's3 put failed');
      throw new AppError('storage_error', `s3_put_failed_${res.status}`);
    }
    return { key, sizeBytes: buffer.byteLength, sha256, mimeType: contentType };
  }

  async getStream(key: string): Promise<Readable> {
    const url = this.objectUrl(key);
    const headers = await this.sign('GET', url, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) throw new AppError('not_found', `s3_get_failed_${res.status}`);
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async exists(key: string): Promise<boolean> {
    const url = this.objectUrl(key);
    const headers = await this.sign('HEAD', url, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url, { method: 'HEAD', headers });
    return res.ok;
  }

  async delete(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const headers = await this.sign('DELETE', url, 'UNSIGNED-PAYLOAD');
    await fetch(url, { method: 'DELETE', headers });
  }

  async ensureBucket(): Promise<void> {
    const url = `${this.endpoint}/${this.bucket}`;
    const headers = await this.sign('PUT', url, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url, { method: 'PUT', headers });
    if (!res.ok && res.status !== 409) {
      this.logger.warn({ status: res.status }, 'could not ensure bucket (it may exist already)');
    }
  }

  describe(): string {
    return `s3-compatible (${this.bucket} @ ${this.endpoint})`;
  }
}

export async function createStorage(cfg: AppConfig, logger: Logger): Promise<Storage> {
  if (cfg.STORAGE_DRIVER === 's3') {
    const s3 = new S3Storage(cfg, logger);
    await s3.ensureBucket().catch(() => {});
    logger.info({ target: s3.describe() }, 'using s3-compatible storage');
    return s3;
  }
  const local = new LocalStorage(cfg);
  logger.info({ target: local.describe() }, 'using local filesystem storage');
  return local;
}
