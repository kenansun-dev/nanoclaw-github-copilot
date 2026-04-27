import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration100Forkchats } from './100-fork-chats.js';
import { migration101ForkSenderAllowlist } from './101-fork-sender-allowlist.js';
import { migration102ForkRegisteredGroups } from './102-fork-registered-groups.js';
import { migration103ForkScheduledTasks } from './103-fork-scheduled-tasks.js';
import { migration104ForkTaskRunLogs } from './104-fork-task-run-logs.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  moduleApprovalsTitleOptions,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  // Fork migrations 100..104 — schema for fork-only tables (chats,
  // sender_allowlist, registered_groups, scheduled_tasks, task_run_logs).
  // Numbered 100+ so upstream v2 can safely add 014..099 without renaming.
  migration100Forkchats,
  migration101ForkSenderAllowlist,
  migration102ForkRegisteredGroups,
  migration103ForkScheduledTasks,
  migration104ForkTaskRunLogs,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules. `version` stays on
  // the Migration object as an ordering hint within the barrel array;
  // the stored `version` column is auto-assigned at insert time as an
  // applied-order number.
  const applied = new Set<string>(
    (
      db.prepare('SELECT name FROM schema_version').all() as { name: string }[]
    ).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      const next = (
        db
          .prepare(
            'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version',
          )
          .get() as { v: number }
      ).v;
      db.prepare(
        'INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)',
      ).run(next, m.name, new Date().toISOString());
    })();
    log.info('Migration applied', { name: m.name });
  }
}
