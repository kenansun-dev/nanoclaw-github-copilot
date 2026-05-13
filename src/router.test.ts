/**
 * Unit tests for routeInbound() auto-wire path (PR-D, commit 2052834).
 *
 * Covers the block in src/router.ts:~196-280 that, when a message lands on a
 * brand-new channel with `isMention=true`, auto-creates a `messaging_groups`
 * row and walks `config.bindings` to wire matching `agent_groups` via
 * `messaging_group_agents`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import {
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
  getAllMessagingGroups,
} from './db/messaging-groups.js';
import { getDb } from './db/connection.js';
import type { InboundEvent } from './channels/adapter.js';
import type { Binding, NanoclawConfig } from './config-loader.js';

// Mock side-effecting imports the router pulls in transitively.
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock config.js — session-manager imports DATA_DIR from it. Without this
// mock, `src/config.ts` runs `loadConfig()` at module init and crashes on
// our minimal mock shape. We don't actually create sessions in these tests,
// so a tmp DATA_DIR is sufficient.
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-router',
  PACKAGE_ROOT: '/tmp/nanoclaw-test-router',
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  IPC_POLL_INTERVAL: 1000,
  ASSISTANT_NAME: 'Test',
  ASSISTANT_HAS_OWN_NUMBER: false,
  getAssistantName: () => 'Test',
  getConfig: () => ({}),
  reloadConfig: () => {},
  buildTriggerPattern: (s: string) => new RegExp(`^${s}\\b`, 'i'),
}));

// Stub config-loader: tests can swap `mockConfig` to drive bindings.
let mockConfig: Partial<NanoclawConfig> = { bindings: [] };
vi.mock('./config-loader.js', () => ({
  loadConfig: () => mockConfig as NanoclawConfig,
}));

function now(): string {
  return new Date().toISOString();
}

function seedAgent(id: string, name = id): void {
  createAgentGroup({
    id,
    name,
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function dmEvent(platformId: string, isMention = true): InboundEvent {
  return {
    channelType: 'discord',
    platformId,
    threadId: null,
    message: {
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      content: JSON.stringify({ senderId: 'u1', sender: 'User', text: 'hi' }),
      timestamp: now(),
      isMention,
      isGroup: false,
    },
  };
}

function groupEvent(platformId: string, isMention = true): InboundEvent {
  return {
    channelType: 'discord',
    platformId,
    threadId: 'thr-1',
    message: {
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      content: JSON.stringify({ senderId: 'u1', sender: 'User', text: '@bot hi' }),
      timestamp: now(),
      isMention,
      isGroup: true,
    },
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  mockConfig = { bindings: [] };
});

afterEach(() => {
  closeDb();
});

describe('routeInbound auto-wire (PR-D)', () => {
  it('1. DM with binding match creates mg + mga with pattern engage_mode', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'direct', id: '12345' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('12345'));

    const mg = getMessagingGroupByPlatform('discord', '12345');
    expect(mg).toBeDefined();
    const mgas = getMessagingGroupAgents(mg!.id);
    expect(mgas).toHaveLength(1);
    expect(mgas[0].agent_group_id).toBe('main');
    expect(mgas[0].engage_mode).toBe('pattern');
    expect(mgas[0].engage_pattern).toBe('.');
    expect(mgas[0].sender_scope).toBe('all');
    expect(mgas[0].ignored_message_policy).toBe('drop');
  });

  it('2. Group with binding match creates mga with mention-sticky engage_mode', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'group', id: 'grp-9' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(groupEvent('grp-9'));

    const mg = getMessagingGroupByPlatform('discord', 'grp-9');
    expect(mg).toBeDefined();
    const mgas = getMessagingGroupAgents(mg!.id);
    expect(mgas).toHaveLength(1);
    expect(mgas[0].engage_mode).toBe('mention-sticky');
    expect(mgas[0].engage_pattern).toBeNull();
  });

  it('3. No bindings match still creates mg (mention) but 0 mga and no session', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        // Channel mismatch — won't match a discord event.
        { agentId: 'main', match: { channel: 'slack' } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('99999'));

    const mg = getMessagingGroupByPlatform('discord', '99999');
    expect(mg).toBeDefined();
    expect(getMessagingGroupAgents(mg!.id)).toHaveLength(0);

    const sessionRows = getDb().prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number };
    expect(sessionRows.c).toBe(0);
  });

  it('4. isMention=false on unknown channel: no mg auto-created', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'direct', id: '77777' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('77777', /* isMention */ false));

    expect(getMessagingGroupByPlatform('discord', '77777')).toBeUndefined();
    expect(getAllMessagingGroups()).toHaveLength(0);
  });

  it('5. Multiple bindings with same agentId are de-duplicated to one mga', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'direct', id: '55555' } } },
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'direct', id: '55555' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('55555'));

    const mg = getMessagingGroupByPlatform('discord', '55555')!;
    expect(getMessagingGroupAgents(mg.id)).toHaveLength(1);
  });

  it('6. Two bindings with different agentIds both match and wire two mga rows', async () => {
    seedAgent('agent-a');
    seedAgent('agent-b');
    mockConfig = {
      bindings: [
        { agentId: 'agent-a', match: { channel: 'discord', peer: { kind: 'direct', id: '88888' } } },
        { agentId: 'agent-b', match: { channel: 'discord', peer: { kind: 'direct', id: '88888' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('88888'));

    const mg = getMessagingGroupByPlatform('discord', '88888')!;
    const mgas = getMessagingGroupAgents(mg.id);
    expect(mgas).toHaveLength(2);
    const ids = mgas.map((m) => m.agent_group_id).sort();
    expect(ids).toEqual(['agent-a', 'agent-b']);
  });

  it('7. Auto-created mg has unknown_sender_policy=strict (regression for router.ts:213)', async () => {
    mockConfig = { bindings: [] };
    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('regress-1'));

    const mg = getMessagingGroupByPlatform('discord', 'regress-1');
    expect(mg).toBeDefined();
    expect(mg!.unknown_sender_policy).toBe('strict');
  });

  it('8. Binding peer.id substring-matches against event.platformId', async () => {
    seedAgent('main');
    mockConfig = {
      bindings: [
        { agentId: 'main', match: { channel: 'discord', peer: { kind: 'direct', id: '12345' } } },
      ] as Binding[],
    };

    const { routeInbound } = await import('./router.js');
    await routeInbound(dmEvent('discord:user:12345'));

    const mg = getMessagingGroupByPlatform('discord', 'discord:user:12345');
    expect(mg).toBeDefined();
    const mgas = getMessagingGroupAgents(mg!.id);
    expect(mgas).toHaveLength(1);
    expect(mgas[0].agent_group_id).toBe('main');
  });
});
