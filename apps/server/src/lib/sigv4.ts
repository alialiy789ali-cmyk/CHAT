import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature V4 signer (header-based, UNSIGNED-PAYLOAD supported).
 *
 * Why hand-write it: the S3 client SDK is a large dependency tree, and the platform
 * must be able to talk to *any* self-hosted S3-compatible service. This file is
 * small, deterministic and unit-tested against the AWS published test vectors'
 * structure. It is only used by the S3 storage driver.
 */

export interface SignOptions {
  method: string;
  url: string;
  payloadHash: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}

const sha256Hex = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC3986 encoding as required by SigV4 (encode everything except unreserved chars). */
export function uriEncode(input: string, encodeSlash = true): string {
  let out = '';
  for (const char of input) {
    if (/[A-Za-z0-9\-._~]/.test(char)) out += char;
    else if (char === '/') out += encodeSlash ? '%2F' : '/';
    else out += [...Buffer.from(char, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  return out;
}

export function canonicalQueryString(searchParams: URLSearchParams): string {
  return [...searchParams.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join('&');
}

export async function signAwsRequest(opts: SignOptions): Promise<Record<string, string>> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(opts.url);

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': opts.payloadHash,
    ...(opts.extraHeaders ?? {}),
  };

  const sortedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${String(headers[k] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === k) as string] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    opts.method.toUpperCase(),
    url.pathname === '' ? '/' : uriEncode(url.pathname, false),
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
