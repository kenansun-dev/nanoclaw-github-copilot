import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/agent-runner-ghc/* uses vitest (no bun:* deps), include it.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'test/**/*.test.ts',
      'container/agent-runner-ghc/src/**/*.test.ts',
    ],
    exclude: ['test/e2e/**'],
  },
});
