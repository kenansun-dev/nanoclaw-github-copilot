import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { clients, sessions } = vi.hoisted(() => ({ clients: vi.fn(), sessions: vi.fn() }));
// Resolve the runner's own installed SDK, not the host SDK copy.
vi.mock('../container/agent-runner/node_modules/@github/copilot-sdk/dist/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@github/copilot-sdk')>();
  return {
    CopilotClient: class {
      constructor(options: unknown) {
        // Delegate validation to the real SDK; this test double cannot hide its
        // absolute-path constraint. Never start that client or use credentials.
        new actual.CopilotClient(options as import('@github/copilot-sdk').CopilotClientOptions);
        const dirs = (options as { builtinPluginDirectories?: string[] }).builtinPluginDirectories ?? [];
        expect(dirs.length).toBeLessThanOrEqual(64);
        expect(new Set(dirs).size).toBe(dirs.length);
        expect(dirs.every(path.isAbsolute)).toBe(true);
        clients(options);
      }
      async createSession(config: unknown) {
        sessions(config);
        throw new Error('Stopped before session creation or inference');
      }
      start() {
        throw new Error('No runtime may start in constructor tests');
      }
    },
    approveAll: vi.fn(),
  };
});

import '../container/agent-runner/src/providers/copilot.js';
import { getProviderFactory } from '../container/agent-runner/src/providers/provider-registry.js';

const dirs: string[] = [];
afterEach(() => {
  clients.mockClear();
  sessions.mockClear();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Copilot SDK 1.0.13 constructor options', () => {
  it('passes the explicit token and plugin roots through typed SDK options', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sdk-options-'));
    dirs.push(dir);
    // Synthetic fixture only, never a credential or authenticated SDK instance.
    getProviderFactory('copilot')({
      env: {
        NANOCLAW_GITHUB_TOKEN: 'nonfunctional-test-fixture',
        NANOCLAW_PLUGIN_DIRS: dir,
      },
    });
    expect(clients).toHaveBeenCalledExactlyOnceWith({
      gitHubToken: 'nonfunctional-test-fixture',
      builtinPluginDirectories: [dir],
    });
  });

  it('keeps SDK default bundled stdio and omits empty auth/plugin options', () => {
    getProviderFactory('github-copilot')({ env: {} });
    expect(clients).toHaveBeenCalledExactlyOnceWith({});
  });
  it.each([64, 65])('passes only first64 of %i roots to SDK, but all agents to session config', async (count) => {
    const base = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sdk-options-'));
    dirs.push(base);
    const roots = Array.from({ length: count }, (_, i) => {
      const dir = path.join(base, `plugin-${i}`);
      fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'agents', `agent-${i}.md`), `Fixture ${i}.`);
      return dir;
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = getProviderFactory('copilot')({
      env: {
        NANOCLAW_PLUGIN_DIRS: roots.flatMap((dir) => [path.relative(process.cwd(), dir), dir]).join(path.delimiter),
        NANOCLAW_MCP_CONFIG: path.join(base, 'absent-mcp.json'),
      },
    });
    expect(clients).toHaveBeenCalledExactlyOnceWith({ builtinPluginDirectories: roots.slice(0, 64) });
    const query = provider.query({ prompt: 'Not sent', cwd: base });
    const events = [];
    for await (const event of query.events) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: 'Stopped before session creation or inference' }),
    ]);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(sessions.mock.calls[0][0].customAgents.map((a: { name: string }) => a.name)).toEqual(
      roots.map((_, i) => `agent-${i}`),
    );
    const warnings = stderr.mock.calls.filter(([msg]) => String(msg).includes('WARNING:'));
    expect(warnings).toHaveLength(count > 64 ? 1 : 0);
    if (count > 64) expect(warnings[0][0]).toContain(roots[64]);
  });
});
