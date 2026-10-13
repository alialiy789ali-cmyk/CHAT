/**
 * Declarations for optional native dependencies that are loaded dynamically.
 * The server degrades gracefully when they are absent (see lib/password.ts).
 */
declare module '@node-rs/argon2' {
  export function hash(password: string, options?: Record<string, unknown>): Promise<string>;
  export function verify(hash: string, password: string, options?: Record<string, unknown>): Promise<boolean>;
}
