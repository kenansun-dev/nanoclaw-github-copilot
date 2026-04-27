/**
 * Smoke tests for `nanoclaw task` CLI.
 *
 * These don't spin up the full daemon; they seed the dev DB with a few
 * rows via the public db.ts API and assert the CLI's stdout shape so a
 * future refactor can't silently regress the format kenan/VM agreed on
 * (default = all tasks, --chat filter, --status filter, --json).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runTaskCommand } from './task.js';

vi.mock('../db.js', () => {
  const tasks: any[] = [];
  const logs: any[] = [];
  return {
    initDatabase: () => {},
    getAllTasks: () => tasks.slice(),
    getTaskById: (id: string) => tasks.find((t) => t.id === id),
    getTaskRunLogs: (id: string, _limit: number) =>
      logs.filter((l) => l.task_id === id),
    __seed: (rows: any[], runs: any[] = []) => {
      tasks.length = 0;
      tasks.push(...rows);
      logs.length = 0;
      logs.push(...runs);
    },
  };
});

import * as db from '../db.js';

let stdout: string[];
let stderr: string[];
let logSpy: any;
let errSpy: any;

beforeEach(() => {
  stdout = [];
  stderr = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
    stdout.push(args.join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
    stderr.push(args.join(' '));
  });
  process.exitCode = 0;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const sampleTasks = [
  {
    id: 'memory-daily-summary:teams:abc',
    group_folder: 'teams-abc',
    chat_jid: 'teams:abc',
    prompt: 'Summarize today.',
    script: null,
    schedule_type: 'cron' as const,
    schedule_value: '45 23 * * *',
    context_mode: 'group' as const,
    next_run: '2099-01-01T15:45:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active' as const,
    consecutive_group_missing: 0,
    created_at: '2026-04-01T00:00:00.000Z',
  },
  {
    id: 'noisy-paused',
    group_folder: 'tui-default',
    chat_jid: 'tui:default',
    prompt: 'Do a thing.',
    script: null,
    schedule_type: 'interval' as const,
    schedule_value: '60000',
    context_mode: 'isolated' as const,
    next_run: null,
    last_run: '2026-04-26T00:00:00.000Z',
    last_result: 'ok',
    status: 'paused' as const,
    consecutive_group_missing: 5,
    created_at: '2026-04-01T00:00:00.000Z',
  },
];

describe('nanoclaw task list', () => {
  it('with no args, shows ALL tasks across every chat (kenan-approved default)', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['list']);
    const out = stdout.join('\n');
    expect(out).toMatch(/2 tasks/);
    expect(out).toMatch(/active=1/);
    expect(out).toMatch(/paused=1/);
    expect(out).toMatch(/teams:abc/);
    expect(out).toMatch(/tui:default/);
  });

  it('--chat filters to the matching chat_jid only', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['list', '--chat', 'teams:abc']);
    const out = stdout.join('\n');
    expect(out).toMatch(/teams:abc/);
    expect(out).not.toMatch(/tui:default/);
    expect(out).toMatch(/1 task /);
  });

  it('--status filters to one status', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['list', '--status', 'paused']);
    const out = stdout.join('\n');
    expect(out).toMatch(/noisy-paused/);
    expect(out).not.toMatch(/memory-daily-summary/);
  });

  it('--json emits JSON', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['list', '--json']);
    const out = stdout.join('\n');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBeDefined();
  });

  it('flags consecutive_group_missing as a warning line', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['list']);
    const out = stdout.join('\n');
    expect(out).toMatch(/group missing for 5 tick/);
  });

  it('empty result set prints a friendly message (no crash)', async () => {
    (db as any).__seed([]);
    await runTaskCommand(['list']);
    expect(stdout.join('\n')).toMatch(/No scheduled tasks/);
  });
});

describe('nanoclaw task info', () => {
  it('shows full task + recent runs', async () => {
    (db as any).__seed(sampleTasks, [
      {
        id: 1,
        task_id: 'memory-daily-summary:teams:abc',
        run_at: '2026-04-26T15:45:00.000Z',
        duration_ms: 1234,
        status: 'success',
        result: 'wrote 5 bullets',
        error: null,
      },
    ]);
    await runTaskCommand(['info', 'memory-daily-summary:teams:abc']);
    const out = stdout.join('\n');
    expect(out).toMatch(/Task memory-daily-summary:teams:abc/);
    expect(out).toMatch(/cron 45 23 \* \* \*/);
    expect(out).toMatch(/recent runs \(last 1\)/);
    expect(out).toMatch(/wrote 5 bullets/);
  });

  it('unknown id reports error and exits non-zero', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['info', 'no-such-task']);
    expect(stderr.join('\n')).toMatch(/No task with id/);
    expect(process.exitCode).toBe(1);
  });

  it('--json emits structured payload', async () => {
    (db as any).__seed(sampleTasks);
    await runTaskCommand(['info', 'memory-daily-summary:teams:abc', '--json']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.task.id).toBe('memory-daily-summary:teams:abc');
    expect(Array.isArray(parsed.recentRuns)).toBe(true);
  });
});

describe('nanoclaw task — usage', () => {
  it('no args prints usage banner', async () => {
    await runTaskCommand([]);
    const out = stdout.join('\n');
    expect(out).toMatch(/Usage: nanoclaw task/);
    expect(out).toMatch(/list/);
    expect(out).toMatch(/info/);
  });

  it('unknown subcommand exits non-zero', async () => {
    await runTaskCommand(['frobnicate']);
    expect(stderr.join('\n')).toMatch(/Unknown subcommand/);
    expect(process.exitCode).toBe(1);
  });
});
