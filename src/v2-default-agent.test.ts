/**
 * Tests for `src/v2-default-agent.ts` — default-agent folder lookup.
 *
 * Post-PR #49 (Path A v1 isMain removal): only `folderIsDefaultAgent`
 * remains; the dual-read shim was retired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockAgents: { list?: Array<{ id?: string; default?: boolean }>; defaults?: { id?: string } } = {
  defaults: { id: 'main' },
};

vi.mock('./config.js', () => ({
  getConfig: () => ({ agents: mockAgents }),
}));

const { folderIsDefaultAgent } = await import('./v2-default-agent.js');

beforeEach(() => {
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
