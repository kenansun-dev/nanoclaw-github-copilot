import { describe, it, expect } from 'vitest';
import {
  collapseMainDmFolder,
  uniqueIsMainFolder,
  agentSlug,
} from './session-routing.js';
import { RegisteredGroup } from './types-extensions.js';

function group(folder: string, isMain = true): RegisteredGroup {
  return {
    name: 'test',
    folder,
    trigger: 'hey',
    added_at: '2026-04-21T00:00:00Z',
    isMain,
  };
}

describe('collapseMainDmFolder', () => {
  it('returns "main" for isMain DM with no agent', () => {
    expect(
      collapseMainDmFolder(group('main-tg-deadbeef'), undefined, false),
    ).toBe('main');
  });

  it('returns "main-<agent>" for isMain DM with agent', () => {
    expect(
      collapseMainDmFolder(
        group('main-atlas-tg-deadbeef'),
        { agentId: 'atlas' },
        false,
      ),
    ).toBe('main-atlas');
  });

  it('does NOT collapse non-isMain chats', () => {
    expect(
      collapseMainDmFolder(group('teams-conv-123', false), undefined, false),
    ).toBe('teams-conv-123');
  });

  it('does NOT collapse isMain groups (isGroup=true)', () => {
    expect(
      collapseMainDmFolder(group('main-tg-deadbeef'), undefined, true),
    ).toBe('main-tg-deadbeef');
  });

  it('does NOT collapse when isGroup is unknown (conservative)', () => {
    // Channel adapter hasn't recorded chats.is_group yet — stay raw.
    expect(
      collapseMainDmFolder(group('main-tg-deadbeef'), undefined, undefined),
    ).toBe('main-tg-deadbeef');
  });

  it('isolates different agents', () => {
    const atlas = collapseMainDmFolder(
      group('main-atlas-tg-aaa'),
      { agentId: 'atlas' },
      false,
    );
    const beta = collapseMainDmFolder(
      group('main-beta-tg-bbb'),
      { agentId: 'beta' },
      false,
    );
    const def = collapseMainDmFolder(group('main-tg-ccc'), undefined, false);
    expect(atlas).toBe('main-atlas');
    expect(beta).toBe('main-beta');
    expect(def).toBe('main');
    expect(new Set([atlas, beta, def]).size).toBe(3);
  });

  it('multiple isMain DMs (same agent) collapse to the same canonical', () => {
    const tg = collapseMainDmFolder(
      group('main-tg-deadbeef'),
      undefined,
      false,
    );
    const dc = collapseMainDmFolder(
      group('main-dc-cafebabe'),
      undefined,
      false,
    );
    const tui = collapseMainDmFolder(
      group('main-tui-12345678'),
      undefined,
      false,
    );
    expect(tg).toBe('main');
    expect(dc).toBe('main');
    expect(tui).toBe('main');
  });

  it('treats existing folder="main" rows as a no-op (backwards compat)', () => {
    expect(collapseMainDmFolder(group('main'), undefined, false)).toBe('main');
  });
});

describe('uniqueIsMainFolder', () => {
  it('produces deterministic folders for same jid + agent', () => {
    expect(uniqueIsMainFolder('tg:123', 'atlas')).toBe(
      uniqueIsMainFolder('tg:123', 'atlas'),
    );
  });

  it('produces distinct folders for different jids', () => {
    expect(uniqueIsMainFolder('tg:111')).not.toBe(uniqueIsMainFolder('tg:222'));
  });

  it('uses default-agent prefix when no agentId given', () => {
    expect(uniqueIsMainFolder('tg:123')).toMatch(/^main-tg-[0-9a-f]{8}$/);
  });

  it('uses agent-bucketed prefix when agentId given', () => {
    expect(uniqueIsMainFolder('tg:123', 'atlas')).toMatch(
      /^main-atlas-tg-[0-9a-f]{8}$/,
    );
  });

  it('respects 64-char folder limit even with long agent names', () => {
    const folder = uniqueIsMainFolder(
      'discord:dm:1234567890123456789',
      'very-long-agent-name-that-takes-lots-of-space',
    );
    expect(folder.length).toBeLessThanOrEqual(64);
  });

  it('handles weird channel prefixes safely', () => {
    expect(uniqueIsMainFolder('123')).toMatch(/^main-123-[0-9a-f]{8}$/);
  });
});

describe('agentSlug', () => {
  it('sanitizes special chars consistent with deriveGroupFolder', () => {
    expect(agentSlug('agent@special!chars')).toBe('agent-special-chars');
  });
});
