import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * Strategy: use Argon2id when the native `@node-rs/argon2` module is available
 * (recommended for production, memory-hard), otherwise fall back to scrypt from
 * Node's core — an audited, memory-hard KDF with parameters above the OWASP
 * recommendation for scrypt (N=2^16, r=8, p=1).
 *
 * We never hand-roll a primitive; we only choose between two audited ones.
 * The hash string encodes the algorithm so hashes can be upgraded on login.
 */

export type PasswordAlgorithm = 'argon2id' | 'scrypt';

interface Argon2Module {
  hash: (password: string, options?: Record<string, unknown>) => Promise<string>;
  verify: (hash: string, password: string, options?: Record<string, unknown>) => Promise<boolean>;
}

const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

let argon2: Argon2Module | null | undefined;

async function loadArgon2(): Promise<Argon2Module | null> {
  if (argon2 !== undefined) return argon2;
  try {
    // Optional dependency: the module is resolved at runtime so that a missing
    // native build degrades to scrypt instead of crashing the server.
    const mod = (await import(/* @vite-ignore */ '@node-rs/argon2' as string)) as unknown as Argon2Module;
    argon2 = typeof mod.hash === 'function' ? mod : null;
  } catch {
    argon2 = null;
  }
  return argon2;
}

export async function hashPassword(plain: string): Promise<string> {
  const mod = await loadArgon2();
  if (mod) {
    const hash = await mod.hash(plain, {
      algorithm: 2, // Argon2id
      memoryCost: 19_456, // 19 MiB, OWASP minimum
      timeCost: 2,
      parallelism: 1,
    });
    return hash;
  }
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, 64, SCRYPT_PARAMS);
  return ['scrypt', `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$argon2')) {
    const mod = await loadArgon2();
    if (!mod) return false; // cannot verify an argon2 hash without the module
    try {
      return await mod.verify(stored, plain);
    } catch {
      return false;
    }
  }
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const [, paramsRaw = '', saltB64 = '', hashB64 = ''] = parts;
    const params = Object.fromEntries(
      paramsRaw.split(',').map((kv) => {
        const [k = '', v = '0'] = kv.split('=');
        return [k, Number(v)];
      }),
    );
    const derived = await scrypt(plain, Buffer.from(saltB64, 'base64'), Buffer.from(hashB64, 'base64').length, {
      N: params.N ?? SCRYPT_PARAMS.N,
      r: params.r ?? SCRYPT_PARAMS.r,
      p: params.p ?? SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    const expected = Buffer.from(hashB64, 'base64');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
  return false;
}

/** Reports whether a stored hash should be re-computed with the current best algorithm. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('$argon2') && argon2 !== null;
}

export async function activeAlgorithm(): Promise<PasswordAlgorithm> {
  return (await loadArgon2()) ? 'argon2id' : 'scrypt';
}
