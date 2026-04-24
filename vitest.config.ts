import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'test/**/*.test.ts',
      'container/agent-runner-ghc/src/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
    exclude: ['test/e2e/**'],
  },
});
