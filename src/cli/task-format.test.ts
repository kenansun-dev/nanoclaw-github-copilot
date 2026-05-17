import { describe, it, expect } from 'vitest';
import { formatTasksText, modeLabel, type TaskRow } from './task-format.js';

describe('modeLabel (deprecated, always standalone)', () => {
  it('returns standalone for isolated', () => {
    expect(modeLabel('isolated')).toBe('standalone');
  });
  it('returns standalone for null/undefined/empty', () => {
    expect(modeLabel(null)).toBe('standalone');
    expect(modeLabel(undefined)).toBe('standalone');
    expect(modeLabel('')).toBe('standalone');
  });
  it('returns standalone even for legacy group rows (runtime ignores stored value)', () => {
    expect(modeLabel('group')).toBe('standalone');
  });
  it('returns standalone for unknown values too (kept simple post-deprecation)', () => {
    expect(modeLabel('weird')).toBe('standalone');
  });
});

describe('formatTasksText', () => {
  const baseRow: TaskRow = {
    id: 'task-x',
    group_folder: 'main',
    chat_jid: 'tg:1',
    prompt: 'do a thing',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    next_run: null,
    status: 'active',
    context_mode: 'isolated',
  };

  it('empty list with filterDesc renders human-friendly empty state', () => {
    expect(formatTasksText([], { filterDesc: 'chat=tg:1' })).toBe('No scheduled tasks (chat=tg:1).');
  });

  it('empty list without filter renders bare empty state', () => {
    expect(formatTasksText([])).toBe('No scheduled tasks.');
  });

  it('always shows standalone (legacy group rows render as standalone too)', () => {
    const out = formatTasksText([baseRow, { ...baseRow, id: 'task-y', context_mode: 'group' }]);
    // Both rows render as standalone after PR #46 deprecation.
    expect(out.match(/mode:standalone/g)?.length).toBe(2);
    expect(out).not.toContain('mode:attached');
  });

  it('compact mode hides chat/group line (used by MCP list_tasks)', () => {
    const verbose = formatTasksText([baseRow], { compact: false });
    const compact = formatTasksText([baseRow], { compact: true });
    expect(verbose).toContain('chat:tg:1');
    expect(compact).not.toContain('chat:tg:1');
    expect(compact).toContain('mode:standalone');
  });

  it('counts statuses in header summary', () => {
    const out = formatTasksText([
      baseRow,
      { ...baseRow, id: 'task-y', status: 'paused' },
      { ...baseRow, id: 'task-z', status: 'paused' },
    ]);
    expect(out.split('\n')[0]).toBe('3 tasks (active=1 paused=2)');
  });

  it('treats missing context_mode as standalone (snapshot from older container)', () => {
    const row = { ...baseRow, context_mode: undefined };
    const out = formatTasksText([row]);
    expect(out).toContain('mode:standalone');
  });
});
