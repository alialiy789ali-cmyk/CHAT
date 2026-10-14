import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the mobile client's logic that does not need a device: the E2EE engine (real
 * libsignal, fake transport), the key store, and the pure helpers. Anything that needs React Native
 * or the OS keychain is exercised through the app itself, which is why the store is written against a
 * `KeyValueBackend` interface: `MemoryBackend` is the same object the tests use.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
