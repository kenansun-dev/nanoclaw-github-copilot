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
const HAS_TOKEN =
  !!process.env.GITHUB_TOKEN ||
  !!process.env.COPILOT_GITHUB_TOKEN ||
  fs.existsSync(path.join(os.homedir(), '.copilot', 'config.json'));

let dockerOk = false;
let imageOk = false;
let vaultOk = false;
try {
  if (E2E_ENABLED) {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    dockerOk = true;
    const images = execSync('docker images --format "{{.Repository}}:{{.Tag}}"', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    imageOk = images.includes('nanoclaw-agent-ghc:latest');
    try {
      execSync('curl -sf -o /dev/null --max-time 2 http://localhost:10254/health', {
        stdio: 'pipe',
      });
      vaultOk = true;
    } catch {
      vaultOk = false;
    }
  }
} catch {
  /* not enabled or env not ready */
}

const WORKSPACE = path.join(os.tmpdir(), `nanoclaw-v2-e2e-${Date.now()}`);

const skipReason = !E2E_ENABLED
  ? 'NANOCLAW_E2E_V2_CONTAINER!=1'
  : !HAS_TOKEN
    ? 'no GITHUB_TOKEN / ~/.copilot/config.json'
    : !dockerOk
      ? 'docker not running'
      : !imageOk
        ? 'nanoclaw-agent-ghc:latest image missing'
        : !vaultOk
          ? 'OneCLI vault not reachable at :10254'
          : null;

describe('E2E: v2 container path (GHC smoke)', () => {
  beforeAll(() => {
    if (skipReason) return;
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
    if (skipReason) return;
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
  it.skipIf(skipReason)(
    'round-trips a single prompt through the v2 container path',
    async () => {
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

  // Document the skip explicitly so the suite report says WHY this didn't
  // run, not just "skipped".
  if (skipReason) {
    it(`v2 container e2e skipped: ${skipReason}`, () => {
      expect(skipReason).toBeTruthy();
    });
  }
});
