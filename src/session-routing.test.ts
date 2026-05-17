import { describe, it, expect } from 'vitest';
import { collapseMainDmFolder, uniqueIsMainFolder, agentSlug } from './session-routing.js';

// PR #49 (Path A) cutover: collapseMainDmFolder now takes a folder string
// directly (no RegisteredGroup) and uses pattern-based detection of
// default-agent DM folders (`main(-<agent>)?-<channel>-<8hex>` plus the
// legacy literal 'main').

describe('collapseMainDmFolder', () => {
  it('returns "main" for default-agent DM with no agent', () => {
    expect(collapseMainDmFolder('main-tg-deadbeef', undefined, false)).toBe('main');
  });

  it('returns "main-<agent>" for default-agent DM with agent', () => {
    expect(collapseMainDmFolder('main-atlas-tg-deadbeef', { agentId: 'atlas' }, false)).toBe('main-atlas');
  });

  it('does NOT collapse non-default-agent folders', () => {
    expect(collapseMainDmFolder('teams-conv-123', undefined, false)).toBe('teams-conv-123');
  });

  it('does NOT collapse default-agent folders when isGroup=true', () => {
    expect(collapseMainDmFolder('main-tg-deadbeef', undefined, true)).toBe('main-tg-deadbeef');
  });

  it('does NOT collapse when isGroup is unknown (conservative)', () => {
    expect(collapseMainDmFolder('main-tg-deadbeef', undefined, undefined)).toBe('main-tg-deadbeef');
  });

  it('isolates different agents', () => {
    const atlas = collapseMainDmFolder('main-atlas-tg-aaaaaaaa', { agentId: 'atlas' }, false);
    const beta = collapseMainDmFolder('main-beta-tg-bbbbbbbb', { agentId: 'beta' }, false);
    const def = collapseMainDmFolder('main-tg-cccccccc', undefined, false);
    expect(atlas).toBe('main-atlas');
    expect(beta).toBe('main-beta');
    expect(def).toBe('main');
    expect(new Set([atlas, beta, def]).size).toBe(3);
  });

  it('multiple default-agent DMs (same agent) collapse to the same canonical', () => {
    const tg = collapseMainDmFolder('main-tg-deadbeef', undefined, false);
    const dc = collapseMainDmFolder('main-dc-cafebabe', undefined, false);
    const tui = collapseMainDmFolder('main-tui-12345678', undefined, false);
    expect(tg).toBe('main');
    expect(dc).toBe('main');
    expect(tui).toBe('main');
  });

  it('treats existing folder="main" rows as collapsible (backwards compat)', () => {
    expect(collapseMainDmFolder('main', undefined, false)).toBe('main');
  });
});

describe('uniqueIsMainFolder', () => {
  it('produces deterministic folders for same jid + agent', () => {
    expect(uniqueIsMainFolder('tg:123', 'atlas')).toBe(uniqueIsMainFolder('tg:123', 'atlas'));
  });

  it('produces distinct folders for different jids', () => {
    expect(uniqueIsMainFolder('tg:111')).not.toBe(uniqueIsMainFolder('tg:222'));
  });

  it('uses default-agent prefix when no agentId given', () => {
    expect(uniqueIsMainFolder('tg:123')).toMatch(/^main-tg-[0-9a-f]{8}$/);
  });

  it('uses agent-bucketed prefix when agentId given', () => {
    expect(uniqueIsMainFolder('tg:123', 'atlas')).toMatch(/^main-atlas-tg-[0-9a-f]{8}$/);
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
