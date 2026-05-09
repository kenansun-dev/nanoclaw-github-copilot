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

describe('formatMcpList ascii fallback', () => {
  const baseInfo: McpListInfo = {
    servers: [
      { name: 'github', type: 'http', transport: 'https://api/', source: 'merged', status: 'connected' },
      { name: 'mem', type: 'stdio', transport: 'npx srv', source: 'merged', status: 'unknown' },
      { name: 'lin', type: 'http', transport: 'https://lin/', source: 'merged', status: 'auth-pending' },
      { name: 'bad', type: 'http', transport: 'https://bad/', source: 'merged', status: 'error' },
    ],
    configPath: '/x/nanoclaw.json',
    mcpJsonPath: '/x/mcp.json',
    mcporterInstalled: true,
  };

  it('uses Unicode glyphs by default (Telegram/Discord/CLI)', () => {
    const out = formatMcpList(baseInfo);
    expect(out).toContain('\u2500'); // box-drawing rule
    expect(out).toMatch(/\u2713 github/);
    expect(out).toMatch(/\u2717 bad/);
    expect(out).not.toContain('[OK]');
  });

  it('swaps to ASCII when ascii: true (Teams)', () => {
    const out = formatMcpList(baseInfo, { ascii: true });
    expect(out).not.toContain('\u2500');
    expect(out).not.toContain('\u2713');
    expect(out).not.toContain('\u2717');
    expect(out).toContain('[OK] github');
    expect(out).toContain('[X]  bad');
    expect(out).toContain('[!]  lin');
    expect(out).toContain('[?]  mem');
    // rule line is ASCII dashes
    expect(out).toMatch(/^-{42}$/m);
  });
});

describe('formatMcpList', () => {
  it('renders empty list with helpful add hint', () => {
    const info: McpListInfo = {
      servers: [],
      configPath: '/x/nanoclaw.json',
      mcpJsonPath: '/x/mcp.json',
      mcporterInstalled: false,
    };
    const out = formatMcpList(info);
    expect(out).toContain('MCP Servers (0 configured)');
    expect(out).toContain('(no servers configured)');
    expect(out).toContain('/x/mcp.json');
    expect(out).toContain('mcporter: not installed');
  });

  it('renders mixed http + stdio rows with status glyphs', () => {
    const info: McpListInfo = {
      servers: [
        {
          name: 'github',
          type: 'http',
          transport: 'https://api.githubcopilot.com/mcp/',
          source: 'merged',
          status: 'connected',
        },
        {
          name: 'memory',
          type: 'stdio',
          transport: 'npx -y @modelcontextprotocol/server-memory',
          source: 'merged',
          status: 'unknown',
        },
        {
          name: 'linear',
          type: 'http',
          transport: 'https://mcp.linear.app/sse',
          source: 'merged',
          status: 'auth-pending',
          statusDetail: 'oauth required',
        },
      ],
      configPath: '/x/nanoclaw.json',
      mcpJsonPath: '/x/mcp.json',
      mcporterInstalled: true,
      mcporterDaemon: true,
    };
    const out = formatMcpList(info);
    expect(out).toContain('MCP Servers (3 configured)');
    expect(out).toMatch(/✓ github\s+http\s+https:\/\/api\.githubcopilot\.com\/mcp\//);
    expect(out).toMatch(/\? memory\s+stdio\s+npx -y @modelcontextprotocol\/server-memory/);
    expect(out).toMatch(/! linear\s+http\s+https:\/\/mcp\.linear\.app\/sse  \(oauth required\)/);
    expect(out).toContain('mcporter: installed (daemon: running)');
    expect(out).toContain('Legend:');
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
      mcporterInstalled: false,
    };
    const out = formatMcpList(info);
    // Both rows should have same column positions for transport
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
    const info = await collectMcpList(false);
    expect(info.servers).toHaveLength(0);
    expect(info.mcpJsonPath).toContain('mcp.json');
  });

  it('picks up servers from mcp.json (mcpServers shape)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { url: 'https://api.githubcopilot.com/mcp/' },
          memory: { command: 'npx', args: ['-y', '@x/srv'] },
        },
      }),
    );
    // Ensure nanoclaw.json exists so loadConfig succeeds
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
      mcp: { servers: {} },
    } as any);

    const info = await collectMcpList(false);
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
