import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'test/**/*.test.ts',
      'container/agent-runner-ghc/src/**/*.test.ts',
      // container/agent-runner/* uses bun:test/bun:sqlite, run via `bun test`
      // (see container/agent-runner/package.json). Excluded from vitest.
    ],
    exclude: ['test/e2e/**'],
  },
});
