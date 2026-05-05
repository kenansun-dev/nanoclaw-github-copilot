/**
 * Unit tests for /mcp slash command + `nanoclaw mcp` CLI formatter.
 * Pure formatter — no I/O.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { formatMcpList, collectMcpList, type McpListInfo } from './mcp-text.js';
import { setWorkspace, ensureWorkspace } from '../workspace.js';
import { saveConfig } from '../config-loader.js';

describe('formatMcpList', () => {
  it('renders empty list with helpful add hint', () => {
    const info: McpListInfo = {
      servers: [],
      configPath: '/x/nanoclaw.json',
      mcpJsonPath: '/x/mcp.json',
    };
    const out = formatMcpList(info);
    expect(out).toContain('MCP Servers (0 configured)');
    expect(out).toContain('(no servers configured)');
    expect(out).toContain('/x/mcp.json');
    expect(out).not.toContain('mcporter');
  });

  it('renders mixed http + stdio rows', () => {
    const info: McpListInfo = {
      servers: [
        {
          name: 'github',
          type: 'http',
          transport: 'https://api.githubcopilot.com/mcp/',
          source: 'merged',
        },
        {
          name: 'memory',
          type: 'stdio',
          transport: 'npx -y @modelcontextprotocol/server-memory',
          source: 'merged',
        },
        {
          name: 'linear',
          type: 'http',
          transport: 'https://mcp.linear.app/sse',
          source: 'merged',
        },
      ],
      configPath: '/x/nanoclaw.json',
      mcpJsonPath: '/x/mcp.json',
    };
    const out = formatMcpList(info);
    expect(out).toContain('MCP Servers (3 configured)');
    expect(out).toMatch(/github\s+http\s+https:\/\/api\.githubcopilot\.com\/mcp\//);
    expect(out).toMatch(/memory\s+stdio\s+npx -y @modelcontextprotocol\/server-memory/);
    expect(out).toMatch(/linear\s+http\s+https:\/\/mcp\.linear\.app\/sse/);
    expect(out).not.toContain('mcporter');
    expect(out).not.toContain('Legend');
  });

  it('aligns name and type columns to widest entry', () => {
    const info: McpListInfo = {
      servers: [
        {
          name: 'a',
          type: 'http',
          transport: 'https://x',
          source: 'merged',
        },
        {
          name: 'longer-name',
          type: 'stdio',
          transport: 'cmd',
          source: 'merged',
        },
      ],
      configPath: '/x/nanoclaw.json',
      mcpJsonPath: '/x/mcp.json',
    };
    const out = formatMcpList(info);
    const lines = out.split('\n').filter((l) => l.includes('https://x') || l.includes('cmd'));
    expect(lines).toHaveLength(2);
    const httpsCol = lines[0].indexOf('https://x');
    const cmdCol = lines[1].indexOf('cmd');
    expect(httpsCol).toBe(cmdCol);
  });
});

describe('collectMcpList (file read)', () => {
  let tmpDir: string;
  let prevWs: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-text-test-'));
    prevWs = process.env.NANOCLAW_WORKSPACE;
    process.env.NANOCLAW_WORKSPACE = tmpDir;
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    if (prevWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
    else process.env.NANOCLAW_WORKSPACE = prevWs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when no mcp.json or nanoclaw.json mcp section', async () => {
    const info = await collectMcpList();
    expect(info.servers).toHaveLength(0);
    expect(info.mcpJsonPath).toContain('mcp.json');
  });

  it('picks up servers from nanoclaw.json mcp.servers', async () => {
    saveConfig({
      agents: { defaults: { provider: 'github-copilot' } as any },
      channels: {
        discord: { enabled: false },
        telegram: { enabled: false },
        teams: {
          enabled: false,
          authMode: 'secret',
        } as any,
      } as any,
      mcp: {
        servers: {
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', tools: ['*'] },
          memory: { type: 'stdio', command: 'npx', args: ['-y', '@x/srv'] } as any,
        },
      },
    } as any);

    const info = await collectMcpList();
    const names = info.servers.map((s) => s.name).sort();
    expect(names).toEqual(['github', 'memory']);
    const github = info.servers.find((s) => s.name === 'github')!;
    expect(github.type).toBe('http');
    expect(github.transport).toBe('https://api.githubcopilot.com/mcp/');
    const memory = info.servers.find((s) => s.name === 'memory')!;
    expect(memory.type).toBe('stdio');
    expect(memory.transport).toBe('npx -y @x/srv');
  });
});
