import { describe, it, expect } from 'vitest';
import { _reconcilePure } from './chat-reconcile.js';
import type { NanoclawConfig } from './config-loader.js';

const baseConfig = (): NanoclawConfig =>
  ({
    chats: {} as any,
    channels: {} as any,
    agents: { defaults: { triggerWord: '!' } } as any,
  }) as any;

const grp = (name: string, requiresTrigger = false) => ({
  name,
  requiresTrigger,
  folder: 'main',
  trigger: '!',
  added_at: '2026-04-20T00:00:00Z',
});

// PR #49 (Path A) cutover: isMain dedupe + mirror logic was retired.
// Reconcile now only backfills DB-only chats into config; default-agent
// designation flows from agents.list[].default in v2.

describe('chat-reconcile / _reconcilePure', () => {
  it('imports DB-only chats into config and assigns ids', () => {
    const config = baseConfig();
    const groups = {
      'tg:1': grp('alpha'),
      'tg:2': grp('beta'),
      'tg:3': grp('gamma'),
    };
    const r = _reconcilePure(config, groups);
    expect(r.added).toEqual(['tg:1', 'tg:2', 'tg:3']);
    expect(config.chats['tg:1'].id).toBe(1);
    expect(config.chats['tg:2'].id).toBe(2);
    expect(config.chats['tg:3'].id).toBe(3);
  });

  it('preserves existing config entries (config-only)', () => {
    const config = baseConfig();
    config.chats['tg:1'] = { id: 5, name: 'preserved' } as any;
    const r = _reconcilePure(config, {});
    expect(r.added).toEqual([]);
    expect(config.chats['tg:1'].id).toBe(5);
  });

  it('does not duplicate when both stores already agree', () => {
    const config = baseConfig();
    config.chats['tg:1'] = { id: 1, name: 'shared' } as any;
    const groups = { 'tg:1': grp('shared') };
    const r = _reconcilePure(config, groups);
    expect(r.added).toEqual([]);
  });

  it('honours pre-existing config ids when filling gaps from DB', () => {
    const config = baseConfig();
    config.chats['tg:5'] = { id: 5, name: 'pre' } as any;
    const groups = {
      'tg:5': grp('pre'),
      'tg:6': grp('new1'),
      'tg:7': grp('new2'),
    };
    _reconcilePure(config, groups);
    expect(config.chats['tg:5'].id).toBe(5);
    expect(config.chats['tg:6'].id).toBe(6);
    expect(config.chats['tg:7'].id).toBe(7);
  });

  it('is idempotent: second pass over the reconciled state is a no-op', () => {
    const config = baseConfig();
    const groups = {
      'tg:1': grp('a'),
      'tg:2': grp('b'),
    };
    _reconcilePure(config, groups);
    const r2 = _reconcilePure(config, groups);
    expect(r2.added).toEqual([]);
  });
});
