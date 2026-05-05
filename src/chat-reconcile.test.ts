import { describe, it, expect } from 'vitest';
import { _reconcilePure } from './chat-reconcile.js';
import type { NanoclawConfig } from './config-loader.js';

const baseConfig = (): NanoclawConfig =>
  ({
    chats: {} as any,
    channels: {} as any,
    agents: { defaults: { triggerWord: '!' } } as any,
  }) as any;

const grp = (name: string, isMain = false, requiresTrigger = false) => ({
  name,
  isMain,
  requiresTrigger,
  folder: 'main',
  trigger: '!',
  added_at: '2026-04-20T00:00:00Z',
});

describe('chat-reconcile / _reconcilePure', () => {
  it('imports DB-only chats into config and assigns ids', () => {
    const config = baseConfig();
    const groups = {
      'tg:1': grp('alpha', false),
      'tg:2': grp('beta', false),
      'tg:3': grp('gamma', false),
    };
    const r = _reconcilePure(config, groups);
    expect(r.added).toEqual(['tg:1', 'tg:2', 'tg:3']);
    expect(config.chats['tg:1'].id).toBe(1);
    expect(config.chats['tg:2'].id).toBe(2);
    expect(config.chats['tg:3'].id).toBe(3);
  });

  it('preserves existing config entries (config-only)', () => {
    const config = baseConfig();
    config.chats['tg:1'] = { id: 5, name: 'preserved', isMain: true } as any;
    const r = _reconcilePure(config, {});
    expect(r.added).toEqual([]);
    expect(config.chats['tg:1'].id).toBe(5);
    expect(config.chats['tg:1'].isMain).toBe(true);
  });

  it('does not duplicate when both stores already agree', () => {
    const config = baseConfig();
    config.chats['tg:1'] = { id: 1, name: 'shared', isMain: true } as any;
    const groups = { 'tg:1': grp('shared', true) };
    const r = _reconcilePure(config, groups);
    expect(r.added).toEqual([]);
    expect(r.dedupedMains).toEqual([]);
    expect(r.mirroredToDb).toEqual([]);
    expect(r.keptMain).toBe('tg:1');
  });

  // Reproduces kenans 2026-04-20 production state: 4 DB-only mains all
  // mounting `main/` simultaneously. Reconcile must import them, dedupe
  // to one main (lowest id), and mark the other 3 for DB mirror.
  it('handles 4-DB-only-main mount-collision scenario from production deploy', () => {
    const config = baseConfig();
    const groups = {
      'tg:8731187021': grp('kenan', true),
      'tui:1': grp('tui-1', true),
      'tui:3': grp('tui-3', true),
      'tui:4': grp('tui-4', true),
      'teams:abc': grp('kenan-teams', false),
    };
    const r = _reconcilePure(config, groups);
    expect(r.added).toHaveLength(5);
    expect(r.keptMain).toBe('tg:8731187021');
    expect(r.dedupedMains).toEqual(['tui:1', 'tui:3', 'tui:4']);
    expect(r.mirroredToDb.sort()).toEqual(['tui:1', 'tui:3', 'tui:4']);
    expect(r.mirroredToDb).not.toContain('tg:8731187021');
    const remaining = Object.entries(config.chats).filter(([, e]) => (e as any).isMain);
    expect(remaining).toHaveLength(1);
    expect(remaining[0][0]).toBe('tg:8731187021');
  });

  it('honours pre-existing config ids when filling gaps from DB', () => {
    const config = baseConfig();
    config.chats['tg:5'] = { id: 5, name: 'pre' } as any;
    const groups = {
      'tg:5': grp('pre', false),
      'tg:6': grp('new1', false),
      'tg:7': grp('new2', false),
    };
    _reconcilePure(config, groups);
    expect(config.chats['tg:5'].id).toBe(5);
    // nextChatId is max+1 -> 6, then 7
    expect(config.chats['tg:6'].id).toBe(6);
    expect(config.chats['tg:7'].id).toBe(7);
  });

  it('is idempotent: second pass over the reconciled state is a no-op', () => {
    const config = baseConfig();
    const groups = {
      'tg:1': grp('a', true),
      'tg:2': grp('b', true),
    };
    _reconcilePure(config, groups);
    // After first pass tg:2 isMain is cleared in config; for idempotence
    // we feed groups as they would look after mirroring DB-ward.
    const groupsAfterMirror = {
      'tg:1': grp('a', true),
      'tg:2': grp('b', false),
    };
    const r2 = _reconcilePure(config, groupsAfterMirror);
    expect(r2.added).toEqual([]);
    expect(r2.dedupedMains).toEqual([]);
    expect(r2.mirroredToDb).toEqual([]);
  });

  it('does NOT dedupe multi-isMain DMs when isGroup map says they are DMs (PR #16 share-main)', () => {
    const config = baseConfig();
    const groups = {
      'tg:1': grp('dm-a', true),
      'tg:2': grp('dm-b', true),
    };
    const isGroupByJid = new Map<string, boolean | undefined>([
      ['tg:1', false],
      ['tg:2', false],
    ]);
    const r = _reconcilePure(config, groups, isGroupByJid);
    expect(r.dedupedMains).toEqual([]);
    // Both DMs preserve isMain so the share-main collapse can fire.
    expect(config.chats['tg:1'].isMain).toBe(true);
    expect(config.chats['tg:2'].isMain).toBe(true);
  });

  it('still dedupes multi-isMain GROUPS when isGroup map says they are groups', () => {
    const config = baseConfig();
    const groups = {
      'tg:g1': grp('grp-a', true),
      'tg:g2': grp('grp-b', true),
    };
    const isGroupByJid = new Map<string, boolean | undefined>([
      ['tg:g1', true],
      ['tg:g2', true],
    ]);
    const r = _reconcilePure(config, groups, isGroupByJid);
    // Lowest id wins
    expect(r.keptMain).toBe('tg:g1');
    expect(r.dedupedMains).toEqual(['tg:g2']);
    expect(config.chats['tg:g2'].isMain).toBeUndefined();
  });

  it('mixed: keeps single main group + preserves multiple isMain DMs', () => {
    const config = baseConfig();
    const groups = {
      'tg:g1': grp('grp', true),
      'tg:dm1': grp('dm-a', true),
      'tg:dm2': grp('dm-b', true),
    };
    const isGroupByJid = new Map<string, boolean | undefined>([
      ['tg:g1', true],
      ['tg:dm1', false],
      ['tg:dm2', false],
    ]);
    const r = _reconcilePure(config, groups, isGroupByJid);
    // Only 1 group main → no dedupe
    expect(r.dedupedMains).toEqual([]);
    expect(config.chats['tg:g1'].isMain).toBe(true);
    expect(config.chats['tg:dm1'].isMain).toBe(true);
    expect(config.chats['tg:dm2'].isMain).toBe(true);
  });
});
