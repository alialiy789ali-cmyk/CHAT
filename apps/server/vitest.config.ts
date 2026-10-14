import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 *  - `unit` — pure logic and infrastructure adapters, no database, parallel,
 *  - `e2e`  — a real server process (embedded PostgreSQL, WebSocket, HTTP) running the
 *             acceptance criteria; runs sequentially because it owns a database.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          setupFiles: ['tests/helpers/setup-e2e.ts'],
        },
      },
    ],
  },
});
