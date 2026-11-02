// Tests: `bun run test` (or `bun run test:watch`).
//   tests/server: the server's logic, against a throwaway data folder (never your real data/)
//   tests/web:    browser helpers, in a simulated DOM (happy-dom)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/eve-build.ts'],
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/server/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/server/setup.ts'],
          // every file gets its own data folder and module state
          isolate: true,
          // API tests also own a Bun sidecar.
          maxWorkers: 4,
          testTimeout: 30_000,
          expect: { poll: { timeout: 10_000 } },
        },
      },
      {
        test: {
          name: 'web',
          maxWorkers: 4,
          include: ['tests/web/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
