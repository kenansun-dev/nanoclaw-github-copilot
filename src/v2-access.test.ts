import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { checkInboundAccess, holdMessageForPairing } from './v2-access.js';
import type { NanoclawConfig, AccountAccessConfig } from './config-loader.js';
import { initTestDb, closeDb, runMigrations } from './db/index.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

const TEST_DIR = path.join(os.tmpdir(), `nanoclaw-v2-access-${process.pid}`);

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

function makeConfig(account?: AccountAccessConfig): NanoclawConfig {
  return {
    agents: {
      defaults: {
        model: 'test',
        name: 'Test',
        triggerWord: '@test',
        hasOwnNumber: false,
        mode: 'host',
      },
      list: [
        {
          id: 'main',
          default: true,
          model: 'test',
          name: 'Main',
          triggerWord: '@main',
          hasOwnNumber: false,
          mode: 'host',
        },
      ],
    },
    channels: {
      discord: { enabled: false },
      telegram: account
        ? ({ enabled: true, accounts: { default: account } } as any)
        : { enabled: true },
      teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
    },
    mcp: { servers: {} },
    skills: { directories: [], disabled: [] },
    sandbox: {
      runtime: 'docker',
      image: 'test',
      timeout: 300000,
      maxOutputSize: 1048576,
      maxConcurrent: 1,
    },
    chats: {},
    pairing: { mode: 'disabled' },
    credentialProxy: { port: 3001 },
    logLevel: 'info',
    timezone: 'UTC',
  } as NanoclawConfig;
}

function now() {
  return new Date().toISOString();
}

let db: ReturnType<typeof initTestDb>;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('checkInboundAccess — legacy compat', () => {
  it('allows when channel has no accounts map (legacy config)', () => {
    const result = checkInboundAccess(makeConfig(), db, {
      channelType: 'telegram',
      platformId: 'dm-1',
      isGroup: false,
      senderRawId: 'rando',
      isMention: false,
      text: 'hi',
    });
    expect(result.action).toBe('allow');
  });

  it('allows when account has no v2 access fields (credentials-only)', () => {
    const cfg = makeConfig();
    (cfg.channels.telegram as any).accounts = { default: { botToken: 'abc' } };
    const result = checkInboundAccess(cfg, db, {
      channelType: 'telegram',
      platformId: 'dm-1',
      isGroup: false,
      senderRawId: 'rando',
      isMention: false,
      text: 'hi',
    });
    expect(result.action).toBe('allow');
  });
});

describe('checkInboundAccess — DM branch', () => {
  it('allows sender in allowFrom', () => {
    const result = checkInboundAccess(
      makeConfig({ allowFrom: ['friend'], dmPolicy: 'strict' }),
      db,
      {
        channelType: 'telegram',
        platformId: 'dm-1',
        isGroup: false,
        senderRawId: 'friend',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('dmPolicy=open allows non-allowFrom sender', () => {
    const result = checkInboundAccess(makeConfig({ dmPolicy: 'open' }), db, {
      channelType: 'telegram',
      platformId: 'dm-1',
      isGroup: false,
      senderRawId: 'rando',
      isMention: false,
      text: 'hi',
    });
    expect(result.action).toBe('allow');
  });

  it('dmPolicy=strict denies non-allowFrom sender', () => {
    const result = checkInboundAccess(
      makeConfig({ dmPolicy: 'strict', allowFrom: ['friend'] }),
      db,
      {
        channelType: 'telegram',
        platformId: 'dm-1',
        isGroup: false,
        senderRawId: 'rando',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('deny');
    expect(result.reason).toContain('strict');
  });

  it('dmPolicy=pairing holds non-allowFrom sender', () => {
    const result = checkInboundAccess(
      makeConfig({ dmPolicy: 'pairing' }),
      db,
      {
        channelType: 'telegram',
        platformId: 'dm-1',
        isGroup: false,
        senderRawId: 'rando',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('hold-pairing');
  });

  it('default policy (unset) is pairing', () => {
    const result = checkInboundAccess(makeConfig({ allowFrom: ['friend'] }), db, {
      channelType: 'telegram',
      platformId: 'dm-1',
      isGroup: false,
      senderRawId: 'rando',
      isMention: false,
      text: 'hi',
    });
    expect(result.action).toBe('hold-pairing');
  });
});

describe('checkInboundAccess — group branch', () => {
  it('sender in group.allowFrom is allowed (no mention required when override)', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'strict',
        groups: { 'g-1': { allowFrom: ['alice'], requireMention: false } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'alice',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('cascades to account.groupAllowFrom when group-level allowFrom undefined', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'strict',
        groupAllowFrom: ['bob'],
        groups: { 'g-1': { requireMention: false } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'bob',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('cascades to account.allowFrom when group and groupAllowFrom undefined', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'strict',
        allowFrom: ['carol'],
        groups: { 'g-1': { requireMention: false } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'carol',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('groupPolicy=open allows non-allowlisted sender (with mention)', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'open',
        groups: { 'g-1': { requireMention: true } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'rando',
        isMention: true,
        text: '@bot hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('groupPolicy=strict denies non-allowlisted sender', () => {
    const result = checkInboundAccess(
      makeConfig({ groupPolicy: 'strict', allowFrom: ['friend'] }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'rando',
        isMention: true,
        text: '@bot hi',
      },
    );
    expect(result.action).toBe('deny');
  });

  it('specific group id overrides wildcard *', () => {
    const cfg = makeConfig({
      groupPolicy: 'strict',
      groups: {
        '*': { allowFrom: ['everyone'], requireMention: false },
        'g-1': { allowFrom: ['only-alice'], requireMention: false },
      },
    });
    const denyResult = checkInboundAccess(cfg, db, {
      channelType: 'telegram',
      platformId: 'g-1',
      isGroup: true,
      senderRawId: 'everyone',
      isMention: false,
      text: 'hi',
    });
    expect(denyResult.action).toBe('deny');
    const allowResult = checkInboundAccess(cfg, db, {
      channelType: 'telegram',
      platformId: 'g-1',
      isGroup: true,
      senderRawId: 'only-alice',
      isMention: false,
      text: 'hi',
    });
    expect(allowResult.action).toBe('allow');
  });

  it('wildcard * is used when no specific group entry exists', () => {
    const cfg = makeConfig({
      groupPolicy: 'strict',
      groups: { '*': { allowFrom: ['alice'], requireMention: false } },
    });
    const result = checkInboundAccess(cfg, db, {
      channelType: 'telegram',
      platformId: 'g-2',
      isGroup: true,
      senderRawId: 'alice',
      isMention: false,
      text: 'hi',
    });
    expect(result.action).toBe('allow');
  });

  it('requireMention=true denies allowed sender without a mention', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'open',
        groups: { 'g-1': { requireMention: true } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'rando',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('deny');
    expect(result.reason).toContain('requireMention');
  });

  it('requireMention=false allows regardless of mention', () => {
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'open',
        groups: { 'g-1': { requireMention: false } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'rando',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('requireMention defaults to true when group entry omits it', () => {
    const result = checkInboundAccess(
      makeConfig({ groupPolicy: 'open' }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'rando',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('deny');
  });
});

describe('checkInboundAccess — owner bypass', () => {
  it('owner role bypasses strict DM policy', () => {
    upsertUser({
      id: 'telegram:owner',
      kind: 'telegram',
      display_name: 'Owner',
      created_at: now(),
    });
    grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const result = checkInboundAccess(
      makeConfig({ dmPolicy: 'strict', allowFrom: [] }),
      db,
      {
        channelType: 'telegram',
        platformId: 'dm-1',
        isGroup: false,
        senderRawId: 'owner',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });

  it('owner role bypasses group requireMention', () => {
    upsertUser({
      id: 'telegram:owner',
      kind: 'telegram',
      display_name: 'Owner',
      created_at: now(),
    });
    grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const result = checkInboundAccess(
      makeConfig({
        groupPolicy: 'strict',
        groups: { 'g-1': { requireMention: true } },
      }),
      db,
      {
        channelType: 'telegram',
        platformId: 'g-1',
        isGroup: true,
        senderRawId: 'owner',
        isMention: false,
        text: 'hi',
      },
    );
    expect(result.action).toBe('allow');
  });
});

describe('holdMessageForPairing', () => {
  it('does not throw (stub)', () => {
    expect(() => holdMessageForPairing('telegram', 'default', 'dm-1', 'hi')).not.toThrow();
  });
});
