/**
 * Tests for `src/v2-default-agent.ts` — Bucket C dual-read helper.
 *
 * See docs/proposals/2026-05-14-isMain-cutover-buckets.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockAgents: { list?: Array<{ id?: string; default?: boolean }>; defaults?: { id?: string } } = {
  defaults: { id: 'main' },
};

vi.mock('./config.js', () => ({
  getConfig: () => ({ agents: mockAgents }),
}));

const warnSpy = vi.fn();
vi.mock('./log-extensions.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const { folderIsDefaultAgent, isMainDualRead, __resetIsMainDualReadDedupForTests } = await import(
  './v2-default-agent.js'
);

beforeEach(() => {
  warnSpy.mockReset();
  __resetIsMainDualReadDedupForTests();
  mockAgents = { defaults: { id: 'main' } };
});

describe('folderIsDefaultAgent', () => {
  it('returns null for empty folder', () => {
    expect(folderIsDefaultAgent('')).toBeNull();
  });

  it('falls back to "main" when no list and defaults.id missing', () => {
    mockAgents = { defaults: {} };
    expect(folderIsDefaultAgent('main')).toBe(true);
    expect(folderIsDefaultAgent('global')).toBe(false);
  });

  it('uses defaults.id when no list is set', () => {
    mockAgents = { defaults: { id: 'coder' } };
    expect(folderIsDefaultAgent('coder')).toBe(true);
    expect(folderIsDefaultAgent('main')).toBe(false);
  });

  it('picks the entry with default:true', () => {
    mockAgents = {
      defaults: { id: 'main' },
      list: [
        { id: 'coder', default: false },
        { id: 'researcher', default: true },
      ],
    };
    expect(folderIsDefaultAgent('researcher')).toBe(true);
    expect(folderIsDefaultAgent('coder')).toBe(false);
    expect(folderIsDefaultAgent('main')).toBe(false);
  });

  it('falls back to first list entry when none flagged default', () => {
    mockAgents = {
      defaults: { id: 'main' },
      list: [{ id: 'coder' }, { id: 'researcher' }],
    };
    expect(folderIsDefaultAgent('coder')).toBe(true);
    expect(folderIsDefaultAgent('researcher')).toBe(false);
  });

  it('returns null when chosen list entry has no id', () => {
    mockAgents = { defaults: { id: 'main' }, list: [{}] };
    expect(folderIsDefaultAgent('main')).toBeNull();
  });
});

describe('isMainDualRead', () => {
  it('returns the v1 answer (authoritative) on agreement, no warn', () => {
    mockAgents = { defaults: { id: 'main' } };
    expect(isMainDualRead('main', true)).toBe(true);
    expect(isMainDualRead('global', false)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns v1 (still authoritative) on mismatch and warns once', () => {
    // v1 says main, v2 disagrees (folder != default-agent id)
    mockAgents = { defaults: { id: 'coder' } };
    expect(isMainDualRead('main', true)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call with the same triple is deduped
    expect(isMainDualRead('main', true)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns v1 unchanged when v2 has no opinion (no warn)', () => {
    mockAgents = { defaults: { id: 'main' }, list: [{}] };
    expect(isMainDualRead('main', true)).toBe(true);
    expect(isMainDualRead('global', false)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
