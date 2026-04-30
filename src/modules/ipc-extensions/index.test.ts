import { describe, expect, it } from 'vitest';

import { ipcFork } from './index.js';

describe('ipcFork module skeleton', () => {
  it('re-exports the four IPC entry points', () => {
    expect(typeof ipcFork.startIpcWatcher).toBe('function');
    expect(typeof ipcFork.processTaskIpc).toBe('function');
    expect(typeof ipcFork.sweepOrphanResponses).toBe('function');
    expect(typeof ipcFork.handlePluginIpc).toBe('function');
  });
});
