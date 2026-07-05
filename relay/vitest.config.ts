import { defineConfig } from 'vitest/config';

// Relay is an isolated subproject (its own package.json/lockfile). Without a
// config here, vitest walks UP and picks the repo-root vitest.config.ts, which
// imports vitest from the root node_modules — not installed in the relay CI job.
// A config file in this dir stops the upward walk and keeps the suite
// self-contained against relay/node_modules.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
