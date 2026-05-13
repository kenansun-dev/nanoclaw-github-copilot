/**
 * Boot-time v2 init smoke tests — ensure that on a fresh workspace the
 * v2 central DB gets initialized, migrations run, and reconcile projects
 * declared config into the v2 tables. Regression coverage for the prod
 * boot bug where `index.ts main()` only called legacy `initDatabase()`
 * and never wired v2 — first inbound throws "Database not initialized".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from './connection.js';
import { initAndReconcileV2 } from './v2-boot.js';

let tmpRoot: string;
let wsDir: string;
let origWs: string | undefined;

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(wsDir, 'nanoclaw.json'), JSON.stringify(cfg, null, 2));
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-v2-boot-'));
  wsDir = path.join(tmpRoot, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  origWs = process.env.NANOCLAW_WORKSPACE;
  process.env.NANOCLAW_WORKSPACE = wsDir;
  const { setWorkspace } = await import('../workspace.js');
  setWorkspace(wsDir);
});

afterEach(async () => {
  closeDb();
  if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
  else process.env.NANOCLAW_WORKSPACE = origWs;
  const { setWorkspace } = await import('../workspace.js');
  setWorkspace('');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('initAndReconcileV2 — boot smoke', () => {
  it('fresh workspace: opens DB, runs migrations, reconciles config', () => {
    writeConfig({
      agents: {
        defaults: {
          provider: 'github-copilot',
          model: 'claude-sonnet-4',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
      channels: {
        telegram: {
          enabled: true,
          accounts: { default: { allowFrom: ['12345'] } },
        },
      },
    });

    const { dbPath, summary } = initAndReconcileV2();

    // DB file landed at the legacy on-disk location so v2-boot-guard
    // can defuse the legacy `sessions` table.
    expect(dbPath).toBe(path.join(wsDir, 'store', 'v2.db'));
    expect(fs.existsSync(dbPath)).toBe(true);

    expect(summary.agentGroups.inserted).toContain('main');
    expect(summary.users.inserted).toContain('telegram:12345');

    // Verify reconcile actually wrote rows the router will read.
    const db = getDb();
    const ag = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get('main') as { id: string } | undefined;
    expect(ag?.id).toBe('main');
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get('telegram:12345') as { id: string } | undefined;
    expect(u?.id).toBe('telegram:12345');
  });

  it('idempotent: second call inserts nothing new', () => {
    writeConfig({
      agents: {
        defaults: {
          provider: 'github-copilot',
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
      channels: {
        telegram: {
          enabled: true,
          accounts: { default: { allowFrom: ['12345'] } },
        },
      },
    });

    initAndReconcileV2();
    const second = initAndReconcileV2();
    expect(second.summary.agentGroups.inserted).toEqual([]);
    expect(second.summary.agentGroups.updated).toEqual([]);
    expect(second.summary.agentGroups.archived).toEqual([]);
    expect(second.summary.users.inserted).toEqual([]);
    expect(second.summary.userRoles.inserted).toEqual([]);
    expect(second.summary.agentGroupMembers.inserted).toBe(0);
  });

  it('empty config (no agents, no allowFrom): no rows but no throw', () => {
    writeConfig({
      agents: {
        defaults: {
          provider: 'github-copilot',
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [],
      },
    });

    const { summary } = initAndReconcileV2();
    expect(summary.agentGroups.inserted).toEqual([]);
    expect(summary.users.inserted).toEqual([]);
    expect(summary.userRoles.inserted).toEqual([]);
    expect(summary.agentGroupMembers.inserted).toBe(0);
  });

  it('projects commands.ownerAllowFrom into user_roles', () => {
    writeConfig({
      agents: {
        defaults: {
          provider: 'github-copilot',
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
      commands: { ownerAllowFrom: ['telegram:99'] },
    });

    const { summary } = initAndReconcileV2();
    expect(summary.userRoles.inserted).toContain('telegram:99');

    const db = getDb();
    const role = db
      .prepare(`SELECT user_id, role FROM user_roles WHERE user_id = 'telegram:99' AND role = 'owner'`)
      .get() as { user_id: string; role: string } | undefined;
    expect(role).toBeDefined();
  });

  it('auto-migrates legacy chats[] config: DM → allowFrom + bindings, group → accounts.<k>.groups', () => {
    // Legacy v1-shape config with chats[]; expect migrate side to translate
    // it into v2 shape (allowFrom + bindings + accounts.<k>.groups), then
    // reconcile to project the new fields into v2 tables.
    writeConfig({
      agents: {
        defaults: {
          provider: 'github-copilot',
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
      channels: {
        telegram: { enabled: true, accounts: { default: { botToken: 'x' } } },
      },
      chats: {
        'tg:8731187021': { name: 'kenan-dm', isMain: true, agentId: 'main' },
      },
    });

    const { migrate, summary } = initAndReconcileV2();

    // Migrator ran (not a no-op).
    expect(migrate.noop).toBe(false);
    expect(migrate.dms).toContain('tg:8731187021');
    expect(migrate.ownersBootstrapped).toContain('telegram:8731187021');

    // Snapshot of pre-migration nanoclaw.json was taken.
    expect(migrate.snapshotPath).toBeTruthy();
    expect(fs.existsSync(migrate.snapshotPath!)).toBe(true);

    // Migrator already inserted the owner user + role inside its own tx,
    // so reconcile sees them as pre-existing (INSERT OR IGNORE → not in
    // summary.inserted). Verify final DB state instead.
    const db = getDb();
    const ownerUser = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get('telegram:8731187021') as { id: string } | undefined;
    expect(ownerUser?.id).toBe('telegram:8731187021');
    const ownerRole = db
      .prepare(`SELECT user_id FROM user_roles WHERE user_id = ? AND role = 'owner'`)
      .get('telegram:8731187021') as { user_id: string } | undefined;
    expect(ownerRole?.user_id).toBe('telegram:8731187021');
    void summary;

    // Verify on-disk config now has v2 fields and `chats` is gone.
    const writtenCfg = JSON.parse(fs.readFileSync(path.join(wsDir, 'nanoclaw.json'), 'utf-8'));
    expect(writtenCfg.chats).toBeUndefined();
    // Migrator writes under channelKey ('tg' from the jid prefix), not channelType ('telegram').
    expect(writtenCfg.channels.tg.accounts.default.allowFrom).toContain('8731187021');
    expect(writtenCfg.commands?.ownerAllowFrom).toContain('telegram:8731187021');
    expect(writtenCfg.bindings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'main',
          match: expect.objectContaining({ channel: 'tg', accountId: 'default' }),
        }),
      ]),
    );
  });
});
