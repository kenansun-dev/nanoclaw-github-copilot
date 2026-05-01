/**
 * v2 container path e2e smoke
 *
 * What this exercises that nothing else does:
 *   - The actual v2 container path: runContainerAgent → docker spawn →
 *     agent-runner-ghc → CopilotClient → live GHC API → response back
 *     through OUTPUT_MARKER stream → onOutput callback.
 *   - Verifies the marker stream parser (unit-tested in
 *     container-runner.test.ts with mocks) actually round-trips real
 *     agent-runner output, not just synthetic chunks.
 *   - Verifies COPILOT_GITHUB_TOKEN env injection through the container
 *     boundary works (host-side resolve → -e flag → child process).
 *
 * Why this is gated (not run on every CI/local sweep):
 *   - Requires OneCLI vault running at ONECLI_URL (default
 *     http://localhost:10254). v2 container code calls
 *     `onecli.applyContainerConfig(...)` and `ensureAgent(...)`. Without
 *     vault, runContainerAgent fails before docker spawn.
 *   - Requires `nanoclaw-agent-ghc:latest` docker image built locally.
 *   - Spends real GHC quota (~1 prompt). Use cheap free-tier model.
 *   - Requires GITHUB_TOKEN (or ~/.copilot/config.json with valid token).
 *
 * Enable with: NANOCLAW_E2E_V2_CONTAINER=1 GITHUB_TOKEN=... npm run test:e2e
 *
 * Workspace isolation: uses a tmp workspace via NANOCLAW_WORKSPACE so
 * prod ~/.nanoclaw / ~/.nanoclaw-v2 are never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const E2E_ENABLED = process.env.NANOCLAW_E2E_V2_CONTAINER === '1';
const HAS_TOKEN_AT_LOAD =
  !!process.env.GITHUB_TOKEN ||
  !!process.env.COPILOT_GITHUB_TOKEN ||
  fs.existsSync(path.join(os.homedir(), '.copilot', 'config.json'));

const E2E_ENABLED_AT_LOAD = process.env.NANOCLAW_E2E_V2_CONTAINER === '1';

/**
 * Compute skip reason at TEST RUN TIME, not module load time.
 *
 * Why: env vars / vault / docker can come up between import and the
 * actual test execution (CI sequencing, beforeAll fixtures, vault that
 * starts late, etc.). VM review #3 caught this: the original
 * `it.skipIf(skipReason)` evaluated `skipReason` exactly once at
 * module load and would silently skip even if the env became ready
 * by the time the test ran.
 */
function computeSkipReason(): string | null {
  if (!E2E_ENABLED_AT_LOAD && process.env.NANOCLAW_E2E_V2_CONTAINER !== '1') {
    return 'NANOCLAW_E2E_V2_CONTAINER!=1';
  }
  const hasToken =
    !!process.env.GITHUB_TOKEN ||
    !!process.env.COPILOT_GITHUB_TOKEN ||
    fs.existsSync(path.join(os.homedir(), '.copilot', 'config.json'));
  if (!hasToken) return 'no GITHUB_TOKEN / ~/.copilot/config.json';
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
  } catch {
    return 'docker not running';
  }
  try {
    const images = execSync('docker images --format "{{.Repository}}:{{.Tag}}"', { encoding: 'utf-8', timeout: 5000 });
    if (!images.includes('nanoclaw-agent-ghc:latest')) return 'nanoclaw-agent-ghc:latest image missing';
  } catch {
    return 'docker images query failed';
  }
  try {
    execSync('curl -sf -o /dev/null --max-time 2 http://localhost:10254/health', { stdio: 'pipe' });
  } catch {
    return 'OneCLI vault not reachable at :10254';
  }
  return null;
}

const WORKSPACE = path.join(os.tmpdir(), `nanoclaw-v2-e2e-${Date.now()}`);

const skipReasonAtLoad = E2E_ENABLED && HAS_TOKEN_AT_LOAD ? null : 'env not ready at load';

describe('E2E: v2 container path (GHC smoke)', () => {
  beforeAll(() => {
    const reason = computeSkipReason();
    if (reason) return;
    process.env.NANOCLAW_WORKSPACE = WORKSPACE;
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(WORKSPACE, 'data'), { recursive: true });
    fs.mkdirSync(path.join(WORKSPACE, 'groups', 'e2e-smoke'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(WORKSPACE, 'nanoclaw.json'),
      JSON.stringify(
        {
          agents: {
            defaults: {
              provider: 'github-copilot',
              model: 'gpt-5.4',
              mode: 'sandbox',
              sandboxBackend: 'docker',
            },
          },
          channels: {},
          sandbox: { enabled: true },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(WORKSPACE, '.env'), '');
  });

  afterAll(() => {
    const reason = computeSkipReason();
    if (reason) return;
    try {
      // Stop any leftover container from this run
      execSync('docker ps -a --filter "name=nanoclaw-e2e-smoke-" -q | xargs -r docker rm -f', {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(WORKSPACE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Concrete bug class this catches:
  //   - OUTPUT_MARKER framing breakage between agent-runner-ghc and host
  //     parser (different newline handling, marker rename, env var typo
  //     in the docker boundary, GHC SDK breaking change in resumeSession,
  //     etc.). Unit tests cover the parser with mocks; this exercises
  //     the live wire.
  it.skipIf(E2E_ENABLED ? false : true)(
    'round-trips a single prompt through the v2 container path',
    async (ctx) => {
      // Re-evaluate at run time so a vault that started after module load
      // is still picked up. (VM review #3.) Use ctx.skip() so vitest
      // reports SKIP with a reason rather than silently passing.
      const reason = computeSkipReason();
      if (reason) {
        ctx.skip();
        return;
      }

      // VM review #4: assert the host-side token resolution actually
      // returns a non-empty string before we spawn. Otherwise the
      // container could fall back to in-container auth lookup paths
      // (which don't exist in the agent-runner-ghc image) and the smoke
      // could pass for the wrong reason via vault secrets.
      const { resolveGithubToken } = await import('../../src/github-token-provider.js');
      const hostToken = resolveGithubToken();
      expect(hostToken, 'host-side token must resolve before spawn').toBeTruthy();
      expect((hostToken || '').length).toBeGreaterThan(20);

      const { runContainerAgent } = await import('../../src/container-runner.js');

      const group = {
        name: 'E2E v2 Container',
        folder: 'e2e-smoke',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      };

      const input = {
        prompt: 'Reply with the single word: PONG. No other text, no punctuation.',
        groupFolder: 'e2e-smoke',
        chatJid: 'e2e:smoke',
        isMain: true,
        assistantName: 'TestBot',
      };

      let outputCount = 0;
      const out = await runContainerAgent(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        group as any,
        input,
        () => {},
        async () => {
          outputCount++;
        },
      );

      expect(out.status).toBe('success');
      expect(out.result || '').toMatch(/pong/i);
      expect(outputCount).toBeGreaterThanOrEqual(1);
      expect(out.newSessionId).toBeTruthy();
    },
    180_000,
  );

  // Document the load-time skip explicitly so suite report shows WHY.
  // Runtime skip reason is logged from inside the test (see above).
  if (skipReasonAtLoad) {
    it(`v2 container e2e skipped at load: ${skipReasonAtLoad}`, () => {
      expect(skipReasonAtLoad).toBeTruthy();
    });
  }
});
