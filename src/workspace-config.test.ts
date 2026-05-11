import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { WORKSPACE_DIR_NAME, LEGACY_WORKSPACE_DIR_NAME } from './workspace-config.js';
import { setWorkspace, resolveWorkspace, assertWorkspaceIsolation } from './workspace.js';

describe('workspace-config (in-place upgrade defaults)', () => {
  afterEach(() => {
    setWorkspace('');
    delete process.env.NANOCLAW_WORKSPACE;
  });

  it('WORKSPACE_DIR_NAME defaults to .nanoclaw (in-place v1↔v2 path)', () => {
    // Module-load-time eval; env override would have been set before import.
    // In normal test run NANOCLAW_WORKSPACE_DIR is unset → default applies.
    if (!process.env.NANOCLAW_WORKSPACE_DIR) {
      expect(WORKSPACE_DIR_NAME).toBe('.nanoclaw');
    }
  });

  it('LEGACY_WORKSPACE_DIR_NAME stays .nanoclaw', () => {
    expect(LEGACY_WORKSPACE_DIR_NAME).toBe('.nanoclaw');
  });

  it('resolveWorkspace defaults to <home>/<WORKSPACE_DIR_NAME>', () => {
    setWorkspace('');
    delete process.env.NANOCLAW_WORKSPACE;
    const expected = path.join(os.homedir(), WORKSPACE_DIR_NAME);
    expect(resolveWorkspace()).toBe(expected);
  });

  it('assertWorkspaceIsolation is a no-op shim and returns resolved ws', () => {
    setWorkspace('');
    delete process.env.NANOCLAW_WORKSPACE;
    expect(() => assertWorkspaceIsolation()).not.toThrow();
    expect(assertWorkspaceIsolation()).toBe(resolveWorkspace());
  });
});
