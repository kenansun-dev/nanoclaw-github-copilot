import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, resolveWorkspace, workspacePath, ensureWorkspace, paths } from './workspace.js';

describe('workspace', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-ws-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setWorkspace(''); // reset
  });

  it('resolveWorkspace returns set path', () => {
    expect(resolveWorkspace()).toBe(tmpDir);
  });

  it('workspacePath joins segments', () => {
    expect(workspacePath('a', 'b')).toBe(path.join(tmpDir, 'a', 'b'));
  });

  it('ensureWorkspace creates directory structure', () => {
    const isNew = ensureWorkspace();
    expect(isNew).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'credentials'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'state'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'logs'))).toBe(true);
  });

  it('ensureWorkspace returns false on second call', () => {
    ensureWorkspace();
    const isNew = ensureWorkspace();
    expect(isNew).toBe(false);
  });

  it('paths.config points to workspace', () => {
    expect(paths.config).toBe(path.join(tmpDir, 'nanoclaw.json'));
  });
});
