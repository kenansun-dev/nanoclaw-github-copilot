import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot = '';
let configuredServers: Record<string, unknown> = {};

vi.mock('./config.js', () => ({
  getConfig: () => ({ mcp: { servers: configuredServers } }),
}));

vi.mock('./workspace.js', () => ({
  paths: {
    get mcpConfig() {
      return path.join(testRoot, 'workspace-mcp.json');
    },
    get mcpTokens() {
      return path.join(testRoot, 'mcp-tokens.json');
    },
  },
}));

import { configuredMcpAzureTokensNeedRefresh, prepareMcpRuntimeConfig } from './mcp-runtime-config.js';

describe('MCP runtime config invalidation', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-runtime-'));
    configuredServers = {
      docs: { type: 'http', url: 'https://mcp.example.test/v1' },
    };
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('recycles when the effective MCP config changes', async () => {
    const outputDir = path.join(testRoot, 'runtime');
    const runtimePath = await prepareMcpRuntimeConfig(outputDir);
    expect(runtimePath).toBe(path.join(outputDir, 'mcp.json'));
    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(false);

    configuredServers = {
      docs: { type: 'http', url: 'https://mcp.example.test/v2' },
    };
    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(true);

    await prepareMcpRuntimeConfig(outputDir);
    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(false);
  });

  it('recycles on removal and deletes stale process-scoped runtime config', async () => {
    const outputDir = path.join(testRoot, 'runtime');
    const runtimePath = await prepareMcpRuntimeConfig(outputDir);
    expect(runtimePath).toBeTruthy();

    configuredServers = {};
    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(true);
    expect(await prepareMcpRuntimeConfig(outputDir)).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, 'mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'mcp.json.source-sha256'))).toBe(false);
    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(false);
  });

  it('recycles legacy runtime configs that have no source fingerprint', async () => {
    const outputDir = path.join(testRoot, 'runtime');
    const runtimePath = await prepareMcpRuntimeConfig(outputDir);
    fs.unlinkSync(`${runtimePath}.source-sha256`);

    expect(await configuredMcpAzureTokensNeedRefresh(runtimePath)).toBe(true);
  });
});
