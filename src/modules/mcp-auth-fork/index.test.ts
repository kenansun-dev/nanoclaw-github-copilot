import { describe, expect, it } from 'vitest';

import { mcpAuthFork } from './index.js';

describe('mcpAuthFork module skeleton', () => {
  it('re-exports mcp-auth helpers', () => {
    expect(typeof mcpAuthFork.loadMcpConfig).toBe('function');
    expect(typeof mcpAuthFork.loadTokenCache).toBe('function');
    expect(typeof mcpAuthFork.saveTokenCache).toBe('function');
    expect(typeof mcpAuthFork.resolveTokensForMcpServers).toBe('function');
  });

  it('re-exports mcporter-integration helpers', () => {
    expect(typeof mcpAuthFork.isMcporterInstalled).toBe('function');
    expect(typeof mcpAuthFork.ensureMcporterConfig).toBe('function');
    expect(typeof mcpAuthFork.loadMcporterConfig).toBe('function');
    expect(typeof mcpAuthFork.addMcporterServer).toBe('function');
    expect(typeof mcpAuthFork.listMcporterServers).toBe('function');
    expect(typeof mcpAuthFork.mcporterNeedsAuth).toBe('function');
    expect(typeof mcpAuthFork.runMcporter).toBe('function');
  });
});
