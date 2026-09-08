import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePluginDirectories as resolveV2 } from '../container/agent-runner/src/plugin-directories.js';
import { resolvePluginDirectories as resolveGhc } from '../container/agent-runner-ghc/src/plugin-directories.js';
import { loadPluginAgents as loadV2 } from '../container/agent-runner/src/providers/load-plugin-agents.js';
import { loadPluginAgents as loadGhc } from '../container/agent-runner-ghc/src/load-plugin-agents.js';

const root = path.resolve(import.meta.dirname, '..');
const fixtures: string[] = [];
function makeDirs(count: number): string[] {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-plugin-dirs-'));
  fixtures.push(base);
  return Array.from({ length: count }, (_, i) => {
    const dir = path.join(base, `plugin-${i}`);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', `agent-${i}.md`), `Agent ${i} fixture.`);
    return dir;
  });
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

for (const [runner, resolve, load] of [
  ['agent-runner', resolveV2, loadV2],
  ['agent-runner-ghc', resolveGhc, loadGhc],
] as const) {
  // The real runner-local SDK constructor validates paths, but never starts a runtime.
  const require = createRequire(path.join(root, 'container', runner, 'package.json'));
  const { CopilotClient } = require('@github/copilot-sdk');
  describe(`${runner} plugin directory policy`, () => {
    it('matches the canonical shared source (no hand-maintained runner drift)', () => {
      const canonical = fs.readFileSync(path.join(root, 'container/shared/plugin-directories.ts'), 'utf8');
      const copy = fs.readFileSync(path.join(root, 'container', runner, 'src/plugin-directories.ts'), 'utf8');
      expect(copy.split('\n').slice(2).join('\n')).toBe(canonical);
    });

    it('normalizes existing relative paths and deduplicates aliases in first-seen order', () => {
      const dirs = makeDirs(2);
      const relative = path.relative(process.cwd(), dirs[1]);
      const warn = vi.fn();
      const result = resolve(
        ['', relative, dirs[0], dirs[1], `${dirs[0]}/../plugin-0`, `${dirs[0]}/missing`, ''].join(path.delimiter),
        warn,
      );
      expect(result.pluginDirs).toEqual([dirs[1], dirs[0]]);
      expect(result.builtinPluginDirectories).toEqual(result.pluginDirs);
      expect(result.builtinPluginDirectories.every(path.isAbsolute)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(() => new CopilotClient({ builtinPluginDirectories: [relative] })).toThrow(/absolute/);
      expect(() => new CopilotClient({ builtinPluginDirectories: result.builtinPluginDirectories })).not.toThrow();
      expect(load(result.pluginDirs).map((a) => a.pluginDir)).toEqual(result.pluginDirs);
    });

    it('does not turn empty or nonexistent entries into the working directory', () => {
      const warn = vi.fn();
      expect(resolve(undefined, warn)).toEqual({ pluginDirs: [], builtinPluginDirectories: [] });
      expect(resolve(path.delimiter.repeat(2), warn).pluginDirs).toEqual([]);
      const [dir] = makeDirs(1);
      expect(resolve(path.join(dir, 'missing'), warn).pluginDirs).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([64, 65, 66])('bounds %i unique directories while retaining every fallback agent', (count) => {
      const dirs = makeDirs(count);
      const warn = vi.fn();
      // Duplicate/relative aliases must not consume the native quota.
      const raw = dirs.flatMap((dir) => [path.relative(process.cwd(), dir), dir]).join(path.delimiter);
      const result = resolve(raw, warn);
      expect(result.pluginDirs).toEqual(dirs);
      expect(result.builtinPluginDirectories).toEqual(dirs.slice(0, 64));
      expect(result.builtinPluginDirectories.length).toBeLessThanOrEqual(64);
      expect(new Set(result.builtinPluginDirectories).size).toBe(result.builtinPluginDirectories.length);
      expect(result.builtinPluginDirectories.every(path.isAbsolute)).toBe(true);
      expect(() => new CopilotClient({ builtinPluginDirectories: result.builtinPluginDirectories })).not.toThrow();
      expect(load(result.pluginDirs).map((a) => a.pluginDir)).toEqual(dirs);
      if (count === 64) {
        expect(warn).not.toHaveBeenCalled();
      } else {
        expect(warn).toHaveBeenCalledTimes(1);
        const message = warn.mock.calls[0][0];
        expect(message).toContain(`${count} unique plugin directories`);
        expect(message).toContain(`${count - 64} skipped directory(s)`);
        expect(message).toContain(JSON.stringify(dirs.slice(64)));
        expect(message).toContain('Native plugin features are not loaded');
        expect(message).toContain('Custom-agent fallback still scans all directories');
        expect(message).toContain('Reduce NANOCLAW_PLUGIN_DIRS');
      }
    });
  });
}

it('wires both entrypoints to the bounded native list and the unbounded fallback list', () => {
  for (const [file, fallback] of [
    ['agent-runner/src/providers/copilot.ts', 'this.pluginDirs'],
    ['agent-runner-ghc/src/index.ts', 'pluginDirs'],
  ]) {
    const source = fs.readFileSync(path.join(root, 'container', file), 'utf8');
    expect(source).toMatch(/resolvePluginDirectories\([^;]*NANOCLAW_PLUGIN_DIRS,\s*log\)/);
    expect(source).toContain('clientOpts.builtinPluginDirectories = builtinPluginDirectories');
    expect(source).toContain(`loadPluginAgents(${fallback},`);
    expect(source).not.toContain('clientOpts.builtinPluginDirectories = pluginDirs');
  }
});
