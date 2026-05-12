import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The shared task formatter is duplicated between host and container
 * because the container has a separate tsconfig rootDir and can't import
 * from src/. The duplicate lives at:
 *   container/agent-runner-ghc/src/cli-shared/task-format.ts
 *
 * This test fails if the two copies drift. If you intentionally update
 * one, copy it to the other before pushing.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

describe('task-format mirror parity', () => {
  it('host src/cli/task-format.ts === container cli-shared/task-format.ts', () => {
    const host = fs.readFileSync(
      path.join(repoRoot, 'src', 'cli', 'task-format.ts'),
      'utf-8',
    );
    const container = fs.readFileSync(
      path.join(repoRoot, 'container', 'agent-runner-ghc', 'src', 'cli-shared', 'task-format.ts'),
      'utf-8',
    );
    if (host !== container) {
      throw new Error(
        'task-format.ts host/container copies diverged. Copy one over the other:\n' +
          '  cp src/cli/task-format.ts container/agent-runner-ghc/src/cli-shared/task-format.ts',
      );
    }
    expect(host).toBe(container);
  });
});
