/**
 * Tests for memory daily-summary cron registration.
 *
 * Uses vi.hoisted() so mock state is initialised before vi.mock factories
 * run (factories themselves are hoisted to the top of the file). This
 * lets us drive ensureDailySummaryTask through its full state-transition
 * matrix without touching real SQLite, real config yaml, or real logger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeTask = {
  id: string;
  status: 'active' | 'paused' | 'completed';
  prompt: string;
  schedule_value: string;
};

const h = vi.hoisted(() => {
  const tasks = new Map<
    string,
    {
      id: string;
      status: 'active' | 'paused' | 'completed';
      prompt: string;
      schedule_value: string;
    }
  >();
  const config: { value: Record<string, unknown> } = { value: {} };
  return { tasks, config };
});

vi.mock('./../db.js', () => ({
  createTask: vi.fn(
    (row: { id: string; prompt: string; schedule_value: string }) => {
      h.tasks.set(row.id, {
        id: row.id,
        status: 'active',
        prompt: row.prompt,
        schedule_value: row.schedule_value,
      });
    },
  ),
  getTaskById: vi.fn((id: string) => h.tasks.get(id)),
  updateTask: vi.fn(
    (id: string, patch: Partial<{ status: 'active' | 'paused' | 'completed'; prompt: string; schedule_value: string }>) => {
      const t = h.tasks.get(id);
      if (!t) return;
      Object.assign(t, patch);
    },
  ),
}));

vi.mock('./../config.js', () => ({ TIMEZONE: 'Asia/Shanghai' }));
vi.mock('./../config-loader.js', () => ({
  loadConfig: () => ({ memory: { dailySummary: h.config.value } }),
}));
vi.mock('./../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureDailySummaryTask } from './cron.js';
import * as dbModule from './../db.js';

const createTask = vi.mocked(dbModule.createTask);
const updateTask = vi.mocked(dbModule.updateTask);

const CHAT = 'discord:test-chat-1';
const ID = `memory-daily-summary:${CHAT}`;

beforeEach(() => {
  h.tasks.clear();
  h.config.value = {};
  createTask.mockClear();
  updateTask.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureDailySummaryTask — disable transitions', () => {
  it('enabled=false + no task → no-op', () => {
    h.config.value = { enabled: false };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('enabled=false + active task → pause', () => {
    h.tasks.set(ID, {
      id: ID,
      status: 'active',
      prompt: 'p',
      schedule_value: '45 23 * * *',
    });
    h.config.value = { enabled: false };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(updateTask).toHaveBeenCalledWith(ID, { status: 'paused' });
    expect(h.tasks.get(ID)?.status).toBe('paused');
  });

  it('enabled=false + paused task → no-op (idempotent)', () => {
    h.tasks.set(ID, {
      id: ID,
      status: 'paused',
      prompt: 'p',
      schedule_value: '45 23 * * *',
    });
    h.config.value = { enabled: false };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('ensureDailySummaryTask — enable transitions', () => {
  it('enabled=true + no task → create active', () => {
    h.config.value = { enabled: true, cron: '45 23 * * *' };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(h.tasks.get(ID)?.status).toBe('active');
  });

  it('enabled=true + paused task → leave status alone (manual override wins)', () => {
    h.tasks.set(ID, {
      id: ID,
      status: 'paused',
      prompt: 'p',
      schedule_value: '45 23 * * *',
    });
    h.config.value = { enabled: true, cron: '45 23 * * *', prompt: 'p' };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(h.tasks.get(ID)?.status).toBe('paused');
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('enabled=true + cron drift → updateTask sync', () => {
    h.tasks.set(ID, {
      id: ID,
      status: 'active',
      prompt: 'p',
      schedule_value: '30 23 * * *',
    });
    h.config.value = { enabled: true, cron: '45 23 * * *', prompt: 'p' };
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(updateTask).toHaveBeenCalled();
    const patch = updateTask.mock.calls[0][1] as { schedule_value?: string };
    expect(patch.schedule_value).toBe('45 23 * * *');
  });

  it('enabled=true + no drift → no update (idempotent)', () => {
    h.tasks.set(ID, {
      id: ID,
      status: 'active',
      prompt: 'p',
      schedule_value: '45 23 * * *',
    });
    // Match the actual DEFAULT_PROMPT by sending the same prompt the SUT
    // built with. We can't easily get it; instead, set drift=false by
    // letting the SUT see what's already there (force-push our prompt
    // into the stored task to match what config supplies).
    h.config.value = { enabled: true, cron: '45 23 * * *', prompt: 'CUSTOM' };
    h.tasks.get(ID)!.prompt = 'CUSTOM';
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(updateTask).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('ensureDailySummaryTask — defaults', () => {
  it('uses 23:45 default cron when config omits it', () => {
    h.config.value = {}; // empty section → all defaults
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(createTask).toHaveBeenCalledTimes(1);
    const row = createTask.mock.calls[0][0] as { schedule_value: string };
    expect(row.schedule_value).toBe('45 23 * * *');
  });

  it('default enabled=true creates task on first call', () => {
    h.config.value = {};
    ensureDailySummaryTask({ chatJid: CHAT, groupFolder: '/tmp/g' });
    expect(h.tasks.has(ID)).toBe(true);
  });
});

// Suppress the unused-FakeTask warning under noUnusedLocals.
export type _FakeTask = FakeTask;
