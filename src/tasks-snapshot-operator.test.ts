/**
 * Regression tests for owner/operator visibility in the `list_tasks`
 * snapshot writer (`writeTasksSnapshot`).
 *
 * Bug (2026-07-28, live Teams install): `/tasks` (slash) showed the
 * owner all tasks after #66 fixed Teams owner-id resolution, but the
 * agent's `list_tasks` tool returned nothing. Root cause: two independent
 * visibility paths —
 *   * `/tasks` filters by isOwner (operator view) — fixed by #66.
 *   * `writeTasksSnapshot` + container `list_tasks` filtered by
 *     `isDefaultAgent` ONLY, with no owner awareness. An owner chatting
 *     from a non-default-agent folder (e.g. a Teams DM whose folder is
 *     not the default agent's id) fell through to the folder filter and
 *     saw an empty list.
 *
 * The write-path IPC gates (src/ipc.ts processTaskIpc) already had the
 * owner-override (isOwner || isDefaultAgent); the read/snapshot path was
 * never migrated. These tests pin the fixed predicate: the snapshot
 * writer now takes a single `canSeeAllTasks` (= isDefaultAgent || owner)
 * boolean, computed host-side by the caller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect IPC writes into a per-test tmpdir so we can read back the
// snapshot the container would consume. Keeps the real filter logic.
let ipcRoot = '';
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (folder: string) => {
    const p = path.join(ipcRoot, folder);
    fs.mkdirSync(p, { recursive: true });
    return p;
  },
}));

const { writeTasksSnapshot } = await import('./container-runner.js');

type SnapTask = Parameters<typeof writeTasksSnapshot>[2][number];

function task(id: string, groupFolder: string, extra: Partial<SnapTask> = {}): SnapTask {
  return {
    id,
    groupFolder,
    prompt: `prompt ${id}`,
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    status: 'active',
    next_run: '2026-07-28T09:00:00',
    ...extra,
  };
}

function readSnapshot(folder: string): Array<{ id: string; groupFolder: string }> {
  const file = path.join(ipcRoot, folder, 'current_tasks.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

beforeEach(() => {
  ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-tasks-snap-'));
});

afterEach(() => {
  fs.rmSync(ipcRoot, { recursive: true, force: true });
});

describe('writeTasksSnapshot — operator (owner or default-agent) visibility', () => {
  const tasks: SnapTask[] = [task('t-main', 'main'), task('t-side', 'side'), task('t-other', 'other')];

  it("operator (owner OR default-agent) sees every group's tasks", () => {
    // The bug: an owner chatting from folder "side" (NOT the default
    // agent) used to fall through to the folder filter and see only
    // t-side. With canSeeAllTasks=true (isDefaultAgent || isOwner) they
    // now see all three.
    writeTasksSnapshot('side', /* canSeeAllTasks */ true, tasks);
    const rows = readSnapshot('side');
    expect(rows.map((r) => r.id).sort()).toEqual(['t-main', 't-other', 't-side']);
  });

  it('non-operator sees only its own folder tasks (unchanged isolation)', () => {
    writeTasksSnapshot('side', /* canSeeAllTasks */ false, tasks);
    const rows = readSnapshot('side');
    expect(rows.map((r) => r.id)).toEqual(['t-side']);
  });

  it('default-agent folder still sees all when canSeeAllTasks=true', () => {
    writeTasksSnapshot('main', true, tasks);
    const rows = readSnapshot('main');
    expect(rows.map((r) => r.id).sort()).toEqual(['t-main', 't-other', 't-side']);
  });

  it('hides internal system tasks from the snapshot even for operators', () => {
    const withSystem: SnapTask[] = [...tasks, task('t-sys', 'main', { kind: 'system' })];
    writeTasksSnapshot('side', true, withSystem);
    const rows = readSnapshot('side');
    expect(rows.some((r) => r.id === 't-sys')).toBe(false);
    // ...but the real user tasks are all present.
    expect(rows.map((r) => r.id).sort()).toEqual(['t-main', 't-other', 't-side']);
  });

  it('non-operator in an empty-match folder gets an empty list (not a crash)', () => {
    writeTasksSnapshot('lonely', false, tasks);
    const rows = readSnapshot('lonely');
    expect(rows).toEqual([]);
  });
});
