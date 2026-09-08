import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { clients } = vi.hoisted(() => ({ clients: vi.fn() }));
// Resolve the runner's own installed SDK, not the host SDK copy.
vi.mock('../container/agent-runner/node_modules/@github/copilot-sdk/dist/index.js', () => ({
  CopilotClient: class {
    constructor(options: unknown) {
      clients(options);
    }
    start() {
      throw new Error('No runtime may start in constructor tests');
    }
  },
  approveAll: vi.fn(),
}));

import '../container/agent-runner/src/providers/copilot.js';
import { getProviderFactory } from '../container/agent-runner/src/providers/provider-registry.js';

const dirs: string[] = [];
afterEach(() => {
  clients.mockClear();
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
});
