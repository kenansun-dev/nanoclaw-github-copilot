import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { WORKSPACE_DIR_NAME, LEGACY_WORKSPACE_DIR_NAME } from './workspace-config.js';
import { setWorkspace, resolveWorkspace, assertWorkspaceIsolation } from './workspace.js';

describe('workspace-config (v2 isolation)', () => {
  afterEach(() => {
    setWorkspace(''); // reset between tests
    delete process.env.NANOCLAW_WORKSPACE;
  });

  it('WORKSPACE_DIR_NAME is the v2 isolated dir on this branch', () => {
    expect(WORKSPACE_DIR_NAME).toBe('.nanoclaw-v2');
  });

  it('LEGACY_WORKSPACE_DIR_NAME stays .nanoclaw for guard checks', () => {
    expect(LEGACY_WORKSPACE_DIR_NAME).toBe('.nanoclaw');
  });

  it('resolveWorkspace defaults to <home>/<WORKSPACE_DIR_NAME>', () => {
    setWorkspace(''); // clear any test override
    delete process.env.NANOCLAW_WORKSPACE;
    const expected = path.join(os.homedir(), WORKSPACE_DIR_NAME);
    expect(resolveWorkspace()).toBe(expected);
  });

  it('assertWorkspaceIsolation throws when workspace == legacy v1 path', () => {
    const v1Path = path.join(os.homedir(), LEGACY_WORKSPACE_DIR_NAME);
    setWorkspace(v1Path);
    expect(() => assertWorkspaceIsolation()).toThrow(/v1 path/i);
  });

  it('assertWorkspaceIsolation passes for v2 default path', () => {
    setWorkspace(''); // clear
    delete process.env.NANOCLAW_WORKSPACE;
    expect(() => assertWorkspaceIsolation()).not.toThrow();
    const ws = assertWorkspaceIsolation();
    expect(path.basename(ws)).toBe(WORKSPACE_DIR_NAME);
  });

  it('assertWorkspaceIsolation passes for arbitrary non-v1 path', () => {
    const customPath = path.join(os.tmpdir(), 'nanoclaw-test-isolated');
    setWorkspace(customPath);
    expect(() => assertWorkspaceIsolation()).not.toThrow();
  });

  it('assertWorkspaceIsolation rejects v1 even via env var', () => {
    setWorkspace(''); // clear explicit override so env var takes effect
    process.env.NANOCLAW_WORKSPACE = path.join(os.homedir(), LEGACY_WORKSPACE_DIR_NAME);
    expect(() => assertWorkspaceIsolation()).toThrow(/v1 path/i);
  });
});
