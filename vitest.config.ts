// Tests: `bun run test` (or `bun run test:watch`).
//   tests/server: the server's logic, against a throwaway data folder (never your real data/)
//   tests/web:    browser helpers, in a simulated DOM (happy-dom)
import { defineConfig } from 'vitest/config';

const workers = process.env.CI ? 2 : 4;

export default defineConfig({
  test: {
    globalSetup: ['tests/eve-build.ts', 'tests/lock-ports.ts'],
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/server/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/server/setup.ts'],
          // every file gets its own data folder and module state
          isolate: true,
          // Each API test process also owns a Bun worker. Leave CI room for both.
          maxWorkers: workers,
          sequence: { groupOrder: 0 },
          testTimeout: 30_000,
          expect: { poll: { timeout: 10_000 } },
        },
      },
      {
        test: {
          name: 'web',
          maxWorkers: workers,
          sequence: { groupOrder: 1 },
          testTimeout: 15_000,
          expect: { poll: { timeout: 10_000 } },
          include: ['tests/web/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
