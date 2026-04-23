/**
 * Unit tests for the plugin install spec parser. Pure-function — no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInstallSpec,
  catalogEntryToSpec,
  type MarketplaceCatalogEntry,
} from './plugin.js';

describe('parseInstallSpec', () => {
  describe('local paths', () => {
    it('parses ./relative paths', () => {
      expect(parseInstallSpec('./my-plugin')).toEqual({
        kind: 'local',
        path: './my-plugin',
      });
    });
    it('parses ../parent paths', () => {
      expect(parseInstallSpec('../sibling')).toEqual({
        kind: 'local',
        path: '../sibling',
      });
    });
    it('parses /absolute paths', () => {
      expect(parseInstallSpec('/opt/plugins/foo')).toEqual({
        kind: 'local',
        path: '/opt/plugins/foo',
      });
    });
    it('parses ~/home paths', () => {
      expect(parseInstallSpec('~/.plugins/foo')).toEqual({
        kind: 'local',
        path: '~/.plugins/foo',
      });
    });
    it('parses Windows drive paths', () => {
      expect(parseInstallSpec('C:\\plugins\\foo')).toEqual({
        kind: 'local',
        path: 'C:\\plugins\\foo',
      });
      expect(parseInstallSpec('D:/plugins/foo')).toEqual({
        kind: 'local',
        path: 'D:/plugins/foo',
      });
    });
  });

  describe('git URLs', () => {
    it('parses https URLs', () => {
      expect(parseInstallSpec('https://github.com/o/r.git')).toEqual({
        kind: 'git',
        url: 'https://github.com/o/r.git',
      });
    });
    it('parses http URLs', () => {
      expect(parseInstallSpec('http://gitea.local/o/r.git')).toEqual({
        kind: 'git',
        url: 'http://gitea.local/o/r.git',
      });
    });
    it('parses ssh URLs', () => {
      expect(parseInstallSpec('git@github.com:o/r.git')).toEqual({
        kind: 'git',
        url: 'git@github.com:o/r.git',
      });
    });
    it('parses URLs without .git extension if scheme present', () => {
      expect(parseInstallSpec('https://gitlab.com/o/r')).toEqual({
        kind: 'git',
        url: 'https://gitlab.com/o/r',
      });
    });
  });

  describe('owner/repo shorthand', () => {
    it('expands to https://github.com/owner/repo.git', () => {
      expect(parseInstallSpec('microsoft/work-iq')).toEqual({
        kind: 'git',
        url: 'https://github.com/microsoft/work-iq.git',
      });
    });
    it('parses owner/repo:subdir form', () => {
      expect(parseInstallSpec('microsoft/work-iq:plugins/workiq')).toEqual({
        kind: 'git',
        url: 'https://github.com/microsoft/work-iq.git',
        subdir: 'plugins/workiq',
      });
    });
    it('handles dashes and dots in owner/repo names', () => {
      expect(parseInstallSpec('my-org/my.repo-name')).toEqual({
        kind: 'git',
        url: 'https://github.com/my-org/my.repo-name.git',
      });
    });
  });

  describe('marketplace specs', () => {
    it('parses plugin@marketplace', () => {
      expect(parseInstallSpec('workiq@copilot-plugins')).toEqual({
        kind: 'marketplace',
        plugin: 'workiq',
        marketplace: 'copilot-plugins',
      });
    });
    it('does NOT match owner/repo:subdir as marketplace (no @)', () => {
      const res = parseInstallSpec('owner/repo:sub');
      expect(res.kind).toBe('git');
    });
    it('does NOT match git@host:path/to.git as marketplace', () => {
      const res = parseInstallSpec('git@github.com:o/r.git');
      expect(res.kind).toBe('git');
    });
  });

  describe('rejection', () => {
    it('throws on empty input', () => {
      expect(() => parseInstallSpec('   ')).toThrow();
    });
    it('throws on garbage', () => {
      expect(() => parseInstallSpec('not a real spec')).toThrow();
    });
    it('throws on bare names without owner', () => {
      expect(() => parseInstallSpec('justaname')).toThrow();
    });
  });
});

describe('catalogEntryToSpec', () => {
  it('passes string source through parseInstallSpec', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'workiq',
      source: 'microsoft/work-iq',
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://github.com/microsoft/work-iq.git',
    });
  });

  it('handles CC-style source object with repo', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo', path: 'plugins/foo' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://github.com/owner/repo.git',
      subdir: 'plugins/foo',
      ref: undefined,
    });
  });

  it('handles raw url object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { url: 'https://gitlab.com/o/r.git', ref: 'v1' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://gitlab.com/o/r.git',
      subdir: undefined,
      ref: 'v1',
    });
  });

  it('handles local source object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { source: 'local', path: '/opt/plugins/foo' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'local',
      path: '/opt/plugins/foo',
    });
  });

  it('throws on empty source object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: {},
    };
    expect(() => catalogEntryToSpec(entry)).toThrow();
  });
});
