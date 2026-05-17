/**
 * IPC privilege-gate tests for `processTaskIpc`.
 *
 * Phase 0 prep for the isOwner cutover (HR list #3, doc:
 * `docs/proposals/2026-05-16-isOwner-privilege-inventory.md`).
 *
 * What this fixture pins down (all using the *current* `isDefaultAgent`
 * predicate, no isOwner yet):
 *   - pause/resume/cancel/update_task: same-folder allowed for non-default
 *     agents; cross-folder requires isDefaultAgent=true.
 *   - schedule_task: targetFolder must equal sourceGroup unless
 *     isDefaultAgent=true.
 *
 * When Phase 1 lands, the predicate becomes `isOwner || isDefaultAgent`.
 * Every assertion below still passes because it's an additive OR — no
 * existing path regresses. A second test file added in Phase 1 will pin
 * the new isOwner=true paths.
 *
 * Mocking strategy follows the project pattern (see audit.test.ts):
 *   - `vi.mock('./db.js', …)` provides task fixtures + spies on mutations.
 *   - `vi.mock('./log-extensions.js', …)` captures `warn`/`info` so we can
 *     assert "Unauthorized …" lines fire (= privilege gate did its job).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ScheduledTask } from './types-extensions.js';

// ── DB mock ────────────────────────────────────────────────────────────
// Tasks are stored in an in-memory map keyed by id. The mock exports the
// four functions ipc.ts imports plus a couple of helpers the test uses to
// seed and inspect state.
const taskStore = new Map<string, ScheduledTask>();
const updateTaskSpy = vi.fn((id: string, updates: Partial<ScheduledTask>) => {
  const t = taskStore.get(id);
  if (!t) return;
  taskStore.set(id, { ...t, ...updates } as ScheduledTask);
});
const deleteTaskSpy = vi.fn((id: string) => {
  taskStore.delete(id);
});
const createTaskSpy = vi.fn((task: ScheduledTask) => {
  taskStore.set(task.id, task);
});

vi.mock('./db.js', () => ({
  createTask: (t: ScheduledTask) => createTaskSpy(t),
  getTaskById: (id: string) => taskStore.get(id),
  updateTask: (id: string, u: Partial<ScheduledTask>) => updateTaskSpy(id, u),
  deleteTask: (id: string) => deleteTaskSpy(id),
}));

// ── Logger mock ────────────────────────────────────────────────────────
const warnSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock('./log-extensions.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: (...args: unknown[]) => infoSpy(...args),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// ── Default-agent v2 mock (not exercised by these tests but required for
// import-time wiring; processTaskIpc takes isDefaultAgent as an explicit
// param so the resolver itself isn't on the path).
vi.mock('./v2-default-agent.js', () => ({
  folderIsDefaultAgent: () => false,
}));

// isOwner mock for Phase 1 owner-override tests. Only 'tg:owner' counts;
// undefined / unknown ids fall through to the legacy isDefaultAgent path.
vi.mock('./modules/permissions/db/user-roles.js', () => ({
  isOwner: (id: string) => id === 'tg:owner',
}));

const { processTaskIpc } = await import('./ipc.js');

// Minimal IpcDeps stub — `processTaskIpc` only touches a few fields for
// the gate-level cases we cover here.
function makeDeps() {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
    reactToMessage: vi.fn(async () => undefined),
    registeredGroups: () => ({
      'tg:111': {
        name: 'Default Agent DM',
        folder: 'main',
        trigger: '',
        added_at: '2026-05-16T00:00:00Z',
        requiresTrigger: false,
      },
      'tg:222': {
        name: 'Side Group',
        folder: 'side',
        trigger: '',
        added_at: '2026-05-16T00:00:00Z',
        requiresTrigger: true,
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => undefined),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };
}

function seedTask(folder: string): ScheduledTask {
  const t: ScheduledTask = {
    id: `task-${folder}-${Math.random().toString(16).slice(2, 8)}`,
    group_folder: folder,
    chat_jid: 'tg:111',
    prompt: 'do thing',
    script: null,
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    next_run: '2026-05-16T01:00:00Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-05-16T00:00:00Z',
    consecutive_group_missing: 0,
  } as ScheduledTask;
  taskStore.set(t.id, t);
  return t;
}

beforeEach(() => {
  taskStore.clear();
  warnSpy.mockReset();
  infoSpy.mockReset();
  updateTaskSpy.mockReset();
  deleteTaskSpy.mockReset();
  createTaskSpy.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('processTaskIpc — privilege gates (current isDefaultAgent predicate)', () => {
  describe('pause_task', () => {
    it('allows non-default agent to pause its own task', async () => {
      const t = seedTask('side');
      await processTaskIpc(
        { type: 'pause_task', taskId: t.id },
        'side', // sourceGroup
        false, // isDefaultAgent
        makeDeps(),
      );
      expect(updateTaskSpy).toHaveBeenCalledWith(t.id, { status: 'paused' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('blocks non-default agent from pausing a foreign-folder task', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc({ type: 'pause_task', taskId: t.id }, 'side', false, makeDeps());
      expect(updateTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: t.id, sourceGroup: 'side' }),
        expect.stringContaining('Unauthorized task pause'),
      );
    });

    it('allows default agent to pause any task (cross-folder)', async () => {
      const t = seedTask('side');
      await processTaskIpc(
        { type: 'pause_task', taskId: t.id },
        'main',
        true, // isDefaultAgent
        makeDeps(),
      );
      expect(updateTaskSpy).toHaveBeenCalledWith(t.id, { status: 'paused' });
    });

    it('allows owner cross-folder via triggeringUserId', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'pause_task', taskId: t.id, triggeringUserId: 'tg:owner' },
        'side',
        false,
        makeDeps(),
      );
      expect(updateTaskSpy).toHaveBeenCalledWith(t.id, { status: 'paused' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('still blocks non-owner non-default cross-folder', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'pause_task', taskId: t.id, triggeringUserId: 'tg:rando' },
        'side',
        false,
        makeDeps(),
      );
      expect(updateTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: t.id }),
        expect.stringContaining('Unauthorized task pause'),
      );
    });
  });

  describe('cancel_task', () => {
    it('blocks non-default agent from cancelling a foreign task', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc({ type: 'cancel_task', taskId: t.id }, 'side', false, makeDeps());
      expect(deleteTaskSpy).not.toHaveBeenCalled();
      expect(taskStore.has(t.id)).toBe(true);
    });

    it('allows default agent to cancel any task', async () => {
      const t = seedTask('side');
      await processTaskIpc({ type: 'cancel_task', taskId: t.id }, 'main', true, makeDeps());
      expect(deleteTaskSpy).toHaveBeenCalledWith(t.id);
    });

    it('allows owner cross-folder via triggeringUserId', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'cancel_task', taskId: t.id, triggeringUserId: 'tg:owner' },
        'side',
        false,
        makeDeps(),
      );
      expect(deleteTaskSpy).toHaveBeenCalledWith(t.id);
    });

    it('still blocks non-owner non-default cross-folder', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'cancel_task', taskId: t.id, triggeringUserId: 'tg:rando' },
        'side',
        false,
        makeDeps(),
      );
      expect(deleteTaskSpy).not.toHaveBeenCalled();
      expect(taskStore.has(t.id)).toBe(true);
    });
  });

  describe('update_task', () => {
    it('blocks non-default agent updating a foreign task', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc({ type: 'update_task', taskId: t.id, prompt: 'new' }, 'side', false, makeDeps());
      expect(updateTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: t.id }),
        expect.stringContaining('Unauthorized task update'),
      );
    });

    it('allows non-default agent to update its own task', async () => {
      const t = seedTask('side');
      await processTaskIpc({ type: 'update_task', taskId: t.id, prompt: 'new prompt' }, 'side', false, makeDeps());
      expect(updateTaskSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({ prompt: 'new prompt' }));
    });

    it('allows owner cross-folder via triggeringUserId', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'update_task', taskId: t.id, prompt: 'owner edit', triggeringUserId: 'tg:owner' },
        'side',
        false,
        makeDeps(),
      );
      expect(updateTaskSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({ prompt: 'owner edit' }));
    });

    it('still blocks non-owner non-default cross-folder', async () => {
      const t = seedTask('other-folder');
      await processTaskIpc(
        { type: 'update_task', taskId: t.id, prompt: 'nope', triggeringUserId: 'tg:rando' },
        'side',
        false,
        makeDeps(),
      );
      expect(updateTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: t.id }),
        expect.stringContaining('Unauthorized task update'),
      );
    });
  });

  describe('schedule_task', () => {
    it('blocks non-default agent scheduling for a foreign chat', async () => {
      // tg:222 → folder 'side'; non-default agent in 'other-folder' tries
      // to schedule there.
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'p',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'tg:222',
        },
        'other-folder',
        false,
        makeDeps(),
      );
      expect(createTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sourceGroup: 'other-folder', targetFolder: 'side' }),
        expect.stringContaining('Unauthorized schedule_task'),
      );
    });

    it('allows non-default agent scheduling for itself', async () => {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'p',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'tg:222',
        },
        'side', // matches targetFolder 'side'
        false,
        makeDeps(),
      );
      expect(createTaskSpy).toHaveBeenCalled();
    });

    it('allows default agent scheduling cross-chat', async () => {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'p',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'tg:222',
        },
        'main',
        true,
        makeDeps(),
      );
      expect(createTaskSpy).toHaveBeenCalled();
    });

    it('allows owner cross-folder via triggeringUserId', async () => {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'p',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'tg:222',
          triggeringUserId: 'tg:owner',
        },
        'other-folder',
        false,
        makeDeps(),
      );
      expect(createTaskSpy).toHaveBeenCalled();
    });

    it('still blocks non-owner non-default cross-folder', async () => {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'p',
          schedule_type: 'cron',
          schedule_value: '0 * * * *',
          targetJid: 'tg:222',
          triggeringUserId: 'tg:rando',
        },
        'other-folder',
        false,
        makeDeps(),
      );
      expect(createTaskSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sourceGroup: 'other-folder', targetFolder: 'side' }),
        expect.stringContaining('Unauthorized schedule_task'),
      );
    });
  });
});
