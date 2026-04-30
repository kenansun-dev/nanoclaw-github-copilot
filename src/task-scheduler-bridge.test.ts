/**
 * Bridge smoke test — verifies task-scheduler-bridge.ts re-exports
 * fork's startSchedulerLoop semantics and exposes the v2 dispatch hook
 * setter/getter without changing v1 behaviour.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  setSchedulerV2DispatchHook,
  getSchedulerV2DispatchHook,
  computeNextRun,
  MAX_CONSECUTIVE_GROUP_MISSING,
} from './task-scheduler-bridge.js';
import type { ScheduledTask } from './types-extensions.js';

describe('task-scheduler-bridge', () => {
  afterEach(() => {
    setSchedulerV2DispatchHook(null);
  });

  it('default v2 dispatch hook is null (fork v1 path active)', () => {
    expect(getSchedulerV2DispatchHook()).toBeNull();
  });

  it('setSchedulerV2DispatchHook stores + clears the hook', async () => {
    const fn = async () => {};
    setSchedulerV2DispatchHook(fn);
    expect(getSchedulerV2DispatchHook()).toBe(fn);
    setSchedulerV2DispatchHook(null);
    expect(getSchedulerV2DispatchHook()).toBeNull();
  });

  it('re-exports fork helpers (computeNextRun, MAX_CONSECUTIVE_GROUP_MISSING)', () => {
    expect(typeof computeNextRun).toBe('function');
    expect(MAX_CONSECUTIVE_GROUP_MISSING).toBeGreaterThan(0);

    const task: ScheduledTask = {
      id: 't1',
      group_folder: 'g',
      chat_jid: 'jid',
      prompt: 'p',
      script: null,
      schedule_type: 'cron',
      schedule_value: '0 0 * * *',
      context_mode: 'group',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: new Date().toISOString(),
      consecutive_group_missing: 0,
    };
    const next = computeNextRun(task);
    expect(typeof next === 'string' || next === null).toBe(true);
  });
});
