/**
 * E2E Quantitative Test Suite for NanoClaw
 *
 * Tests:
 * 1. CLI slash commands — success rate (target: 100%)
 * 2. Context retention across multi-turn conversations (target: ≥80%)
 * 3. Session lifecycle — session ID reuse, not recreate
 *
 * Metrics output: JSON report with pass/fail rates and scores
 *
 * Live agent tests require GITHUB_TOKEN env var.
 * Uses gpt-5.4 (cheap model) for live tests.
 *
 * Note: This is the in-repo E2E suite. The external suite at
 * ~/gitrepos/nanoclaw-e2e-tests/ focuses on integration testing
 * with real channels (Telegram, Teams). This suite tests the
 * agent runtime directly via runHostAgent() for faster iteration
 * and CI compatibility.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Config ──────────────────────────────────────────────────────────────────

const TEST_TIMEOUT = 120_000;
const TEST_WORKSPACE = path.join(os.tmpdir(), `nanoclaw-e2e-${Date.now()}`);
const cliPath = path.join(process.cwd(), 'bin', 'nanoclaw.ts');

// Set workspace env BEFORE any nanoclaw module imports so resolveWorkspace() uses it
process.env.NANOCLAW_WORKSPACE = TEST_WORKSPACE;

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  category: 'slash-command' | 'context-retention' | 'session-lifecycle';
  passed: boolean;
  score: number; // 0-1
  details?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function record(result: TestResult) {
  results.push(result);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runCli(args: string, timeout = 30000): string {
  return execSync(
    `npx tsx ${cliPath} --workspace ${TEST_WORKSPACE} ${args} 2>&1`,
    {
      encoding: 'utf-8',
      timeout,
      env: { ...process.env, NANOCLAW_WORKSPACE: TEST_WORKSPACE },
    },
  );
}

function setupWorkspace() {
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'nanoclaw.json'),
    JSON.stringify(
      {
        agents: {
          defaults: {
            provider: 'github-copilot',
            model: 'gpt-5.4',
            mode: 'host',
          },
        },
        channels: {},
        sandbox: { enabled: false },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(TEST_WORKSPACE, '.env'), '');
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'AGENT.md'),
    '# Test Agent\nYou are a test agent. Follow instructions exactly. Be concise. Always respond.',
  );
}

function printReport() {
  const reportPath = path.join(TEST_WORKSPACE, 'e2e-results.json');
  const report = {
    timestamp: new Date().toISOString(),
    workspace: TEST_WORKSPACE,
    model: 'gpt-5.4',
    results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      byCategory: {} as Record<
        string,
        { total: number; passed: number; avgScore: number }
      >,
    },
  };

  // Compute per-category stats
  for (const cat of ['slash-command', 'context-retention', 'session-lifecycle']) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;
    report.summary.byCategory[cat] = {
      total: catResults.length,
      passed: catResults.filter((r) => r.passed).length,
      avgScore:
        catResults.reduce((s, r) => s + r.score, 0) / catResults.length,
    };
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n═══════════════════════════════════════');
  console.log('  📊 NanoClaw E2E Quantitative Report  ');
  console.log('═══════════════════════════════════════');
  console.log(`Total:  ${report.summary.total}`);
  console.log(
    `Passed: ${report.summary.passed}/${report.summary.total} (${((report.summary.passed / report.summary.total) * 100).toFixed(0)}%)`,
  );
  for (const [cat, stats] of Object.entries(report.summary.byCategory)) {
    console.log(
      `  ${cat}: ${stats.passed}/${stats.total} (avg score: ${(stats.avgScore * 100).toFixed(1)}%)`,
    );
  }
  console.log(`Report: ${reportPath}`);
  console.log('═══════════════════════════════════════\n');
}

// ─── Slash Command Tests (no live agent needed) ──────────────────────────────

describe('E2E: Slash Commands', () => {
  beforeAll(setupWorkspace);
  afterAll(() => {
    printReport();
    // Clean up session state from test workspace
    const sessionsDir = path.join(TEST_WORKSPACE, 'data', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  const slashTests = [
    {
      name: '--help shows usage',
      cmd: '--help',
      check: (o: string) =>
        o.includes('init') && o.includes('start') && o.includes('nanoclaw'),
    },
    {
      name: 'config get returns agents',
      cmd: 'config get',
      check: (o: string) => o.includes('agents'),
    },
    {
      name: 'doctor runs without crash',
      cmd: 'doctor',
      check: () => true,
    },
    {
      name: 'status shows workspace path',
      cmd: 'status',
      check: (o: string) => o.includes(TEST_WORKSPACE),
    },
    {
      name: 'channel list runs cleanly',
      cmd: 'channel list',
      check: () => true,
    },
    {
      name: 'chat list runs cleanly',
      cmd: 'chat list',
      check: () => true,
    },
  ];

  for (const t of slashTests) {
    it(
      t.name,
      () => {
        const start = Date.now();
        try {
          const output = runCli(t.cmd);
          const passed = t.check(output);
          record({
            name: t.name,
            category: 'slash-command',
            passed,
            score: passed ? 1 : 0,
            durationMs: Date.now() - start,
          });
          expect(passed).toBe(true);
        } catch (err: any) {
          record({
            name: t.name,
            category: 'slash-command',
            passed: false,
            score: 0,
            details: err.message?.substring(0, 200),
            durationMs: Date.now() - start,
          });
          throw err;
        }
      },
      TEST_TIMEOUT,
    );
  }
});

// ─── Context Retention Tests (require GITHUB_TOKEN) ──────────────────────────

describe('E2E: Context Retention', () => {
  const HAS_TOKEN = !!process.env.GITHUB_TOKEN;
  const GROUP_FOLDER = 'e2e-context';
  const CHAT_JID = 'e2e:context-test';

  it.skipIf(!HAS_TOKEN)(
    'agent remembers secret code across 3 turns',
    async () => {
      const start = Date.now();
      const { runHostAgent } = await import('../../src/host-runner.js');
      const { initDb } = await import('../../src/db.js');

      // Init DB
      const dbDir = path.join(TEST_WORKSPACE, 'data');
      fs.mkdirSync(dbDir, { recursive: true });
      initDb(path.join(dbDir, 'session-store.db'));

      const group = { name: 'E2E Context', folder: GROUP_FOLDER, isMain: true };
      const baseInput = {
        groupFolder: GROUP_FOLDER,
        chatJid: CHAT_JID,
        isMain: true,
        assistantName: 'TestBot',
      };

      const secret = `CODE-${Math.floor(Math.random() * 10000)}`;

      // Turn 1: set secret
      const t1 = await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: `Remember this secret: ${secret}. Reply with just "Stored: ${secret}"`,
          sessionId: undefined,
        },
        () => {},
      );
      const sid = t1.newSessionId;

      // Turn 2: distraction
      const t2 = await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: 'What is the capital of France? Reply with just the city name.',
          sessionId: sid,
        },
        () => {},
      );

      // Turn 3: recall
      const t3 = await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: 'What was the secret code I told you earlier? Reply with just the code.',
          sessionId: t2.newSessionId || sid,
        },
        () => {},
      );

      const remembered = (t3.result || '').includes(secret);
      const t1ok =
        (t1.result || '').includes(secret) ||
        (t1.result || '').toLowerCase().includes('stored');
      const t2ok =
        (t2.result || '').toLowerCase().includes('paris');

      const score = [remembered, t1ok, t2ok].filter(Boolean).length / 3;

      record({
        name: 'context retention: 3-turn secret recall',
        category: 'context-retention',
        passed: remembered,
        score,
        details: JSON.stringify({
          secret,
          remembered,
          turn1: { ack: t1ok, response: t1.result || '' },
          turn2: { math: t2ok, response: t2.result || '' },
          turn3: { recalled: remembered, response: t3.result || '' },
        }),
        durationMs: Date.now() - start,
      });

      expect(remembered).toBe(true);
    },
    180_000,
  );

  it.skipIf(!HAS_TOKEN)(
    'agent remembers 3 facts simultaneously',
    async () => {
      const start = Date.now();
      const { runHostAgent } = await import('../../src/host-runner.js');

      const group = { name: 'E2E Multi-fact', folder: `${GROUP_FOLDER}-multi`, isMain: true };
      const baseInput = {
        groupFolder: group.folder,
        chatJid: `${CHAT_JID}-multi`,
        isMain: true,
        assistantName: 'TestBot',
      };

      const facts = [
        `COLOR-${Math.floor(Math.random() * 1000)}`,
        `ANIMAL-${Math.floor(Math.random() * 1000)}`,
        `NUMBER-${Math.floor(Math.random() * 1000)}`,
      ];

      // Turn 1: set 3 facts
      const t1 = await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: `Remember these three codes: ${facts[0]}, ${facts[1]}, ${facts[2]}. Reply "Stored all 3."`,
          sessionId: undefined,
        },
        () => {},
      );
      const sid = t1.newSessionId;

      // Turn 2: distraction
      await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: 'What is 7 * 8?',
          sessionId: sid,
        },
        () => {},
      );

      // Turn 3: recall all
      const t3 = await runHostAgent(
        group,
        {
          ...baseInput,
          prompt: 'List all three codes I gave you. Reply with just the codes, comma-separated.',
          sessionId: sid,
        },
        () => {},
      );

      const response = t3.result || '';
      const recalled = facts.filter((f) => response.includes(f));
      const score = recalled.length / facts.length;

      record({
        name: 'context retention: 3-fact simultaneous recall',
        category: 'context-retention',
        passed: score >= 0.67,
        score,
        details: JSON.stringify({
          facts,
          recalled: recalled.length,
          total: facts.length,
          response: response,
        }),
        durationMs: Date.now() - start,
      });

      expect(score).toBeGreaterThanOrEqual(0.67);
    },
    180_000,
  );
});

// ─── Session Lifecycle Tests ─────────────────────────────────────────────────

describe('E2E: Session Lifecycle', () => {
  const HAS_TOKEN = !!process.env.GITHUB_TOKEN;

  it.skipIf(!HAS_TOKEN)(
    'session ID is reused across turns',
    async () => {
      const start = Date.now();
      const { runHostAgent } = await import('../../src/host-runner.js');

      const group = { name: 'E2E Session', folder: 'e2e-session', isMain: true };
      const baseInput = {
        groupFolder: group.folder,
        chatJid: 'e2e:session-test',
        isMain: true,
        assistantName: 'TestBot',
      };

      // Turn 1
      const t1 = await runHostAgent(
        group,
        { ...baseInput, prompt: 'Say "hello".', sessionId: undefined },
        () => {},
      );
      const sid1 = t1.newSessionId;

      // Turn 2 — reuse session
      const t2 = await runHostAgent(
        group,
        { ...baseInput, prompt: 'Say "world".', sessionId: sid1 },
        () => {},
      );
      const sid2 = t2.newSessionId || sid1;

      const reused = sid2 === sid1;

      record({
        name: 'session ID reused across turns',
        category: 'session-lifecycle',
        passed: reused,
        score: reused ? 1 : 0,
        details: `sid1=${sid1} sid2=${sid2}`,
        durationMs: Date.now() - start,
      });

      expect(reused).toBe(true);
    },
    120_000,
  );

  it.skipIf(!HAS_TOKEN)(
    'session ID is valid UUID',
    async () => {
      const start = Date.now();
      const { runHostAgent } = await import('../../src/host-runner.js');

      const group = { name: 'E2E UUID', folder: 'e2e-uuid', isMain: true };

      const t1 = await runHostAgent(
        group,
        {
          prompt: 'Say "ok".',
          sessionId: undefined,
          groupFolder: group.folder,
          chatJid: 'e2e:uuid-test',
          isMain: true,
          assistantName: 'TestBot',
        },
        () => {},
      );

      const sid = t1.newSessionId || '';
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          sid,
        );

      record({
        name: 'session ID is valid UUID',
        category: 'session-lifecycle',
        passed: isUuid,
        score: isUuid ? 1 : 0,
        details: `sessionId=${sid}`,
        durationMs: Date.now() - start,
      });

      expect(isUuid).toBe(true);
    },
    120_000,
  );
});
