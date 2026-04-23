import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadPluginAgents,
  parseAgentFile,
  sanitizeName,
} from '../container/agent-runner-ghc/src/load-plugin-agents';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-load-plugin-agents-'));
}

function writePlugin(
  root: string,
  pluginName: string,
  agents: Record<string, string>,
): string {
  const dir = path.join(root, pluginName);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '0.0.1' }),
  );
  for (const [name, content] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, 'agents', name), content);
  }
  return dir;
}

describe('parseAgentFile', () => {
  it('parses frontmatter + body', () => {
    const out = parseAgentFile(
      `---\nname: my-agent\ndescription: helpful agent\n---\nYou are helpful.\n`,
    );
    expect(out).toMatchObject({
      name: 'my-agent',
      description: 'helpful agent',
      body: 'You are helpful.',
    });
  });

  it('returns null for empty body', () => {
    expect(parseAgentFile(`---\nname: x\n---\n   \n  `)).toBeNull();
    expect(parseAgentFile(``)).toBeNull();
  });

  it('handles missing frontmatter', () => {
    const out = parseAgentFile(`Just a body, no frontmatter.`);
    expect(out).toEqual({ body: 'Just a body, no frontmatter.' });
  });

  it('strips quotes around scalar values', () => {
    const out = parseAgentFile(
      `---\nname: "quoted-name"\ndescription: 'single quoted'\n---\nbody`,
    );
    expect(out?.name).toBe('quoted-name');
    expect(out?.description).toBe('single quoted');
  });

  it('parses tools as comma list and bracketed list', () => {
    expect(
      parseAgentFile(`---\nname: a\ntools: bash, read, write\n---\nbody`)
        ?.tools,
    ).toEqual(['bash', 'read', 'write']);
    expect(
      parseAgentFile(`---\nname: a\ntools: [bash, "read", 'write']\n---\nbody`)
        ?.tools,
    ).toEqual(['bash', 'read', 'write']);
  });

  it('strips BOM', () => {
    const out = parseAgentFile(`\uFEFF---\nname: a\n---\nbody`);
    expect(out?.name).toBe('a');
  });

  it('accepts displayName both camelCase and snake_case in frontmatter', () => {
    expect(
      parseAgentFile(`---\nname: a\ndisplayName: Alpha\n---\nbody`)
        ?.displayName,
    ).toBe('Alpha');
    expect(
      parseAgentFile(`---\nname: a\ndisplay_name: Alpha\n---\nbody`)
        ?.displayName,
    ).toBe('Alpha');
  });
});

describe('sanitizeName', () => {
  it('lowercases + replaces unsafe chars with dashes', () => {
    expect(sanitizeName('Hello World!')).toBe('hello-world');
    expect(sanitizeName('agent.foo/bar')).toBe('agent-foo-bar');
  });
  it('caps length at 64', () => {
    expect(sanitizeName('a'.repeat(100)).length).toBe(64);
  });
  it('returns empty for fully unsafe input', () => {
    expect(sanitizeName('!!!')).toBe('');
  });
});

describe('loadPluginAgents', () => {
  it('returns empty when no plugin dirs exist', () => {
    expect(loadPluginAgents([])).toEqual([]);
    expect(loadPluginAgents(['/nonexistent/path'])).toEqual([]);
  });

  it('loads agents from agents/*.md across plugins', () => {
    const root = tmpDir();
    const pA = writePlugin(root, 'plugin-a', {
      'reviewer.md': `---\nname: reviewer\ndescription: reviews PRs\n---\nReview things.`,
    });
    const pB = writePlugin(root, 'plugin-b', {
      'planner.md': `---\nname: planner\n---\nPlan things.`,
      'README.md.txt': 'should be ignored',
    });

    const agents = loadPluginAgents([pA, pB]);
    expect(agents).toHaveLength(2);
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(byName.reviewer.description).toBe('reviews PRs');
    expect(byName.reviewer.prompt).toBe('Review things.');
    expect(byName.planner.prompt).toBe('Plan things.');
    expect(byName.reviewer.pluginDir).toBe(pA);
    expect(byName.planner.pluginDir).toBe(pB);
  });

  it('falls back to filename stem when frontmatter omits name', () => {
    const root = tmpDir();
    const p = writePlugin(root, 'p', {
      'sentinel.md': `Just a body, no frontmatter at all.`,
    });
    const agents = loadPluginAgents([p]);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('sentinel');
    expect(agents[0].prompt).toBe('Just a body, no frontmatter at all.');
  });

  it('skips agents with empty body and warns', () => {
    const root = tmpDir();
    const p = writePlugin(root, 'p', {
      'empty.md': `---\nname: empty\n---\n   `,
    });
    const warnings: string[] = [];
    const agents = loadPluginAgents([p], { onWarn: (m) => warnings.push(m) });
    expect(agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes('empty.md'))).toBe(true);
  });

  it('dedupes agents by name across plugins (first wins)', () => {
    const root = tmpDir();
    const pA = writePlugin(root, 'a', {
      'r.md': `---\nname: shared\n---\nfrom A`,
    });
    const pB = writePlugin(root, 'b', {
      'r.md': `---\nname: shared\n---\nfrom B`,
    });
    const warnings: string[] = [];
    const agents = loadPluginAgents([pA, pB], {
      onWarn: (m) => warnings.push(m),
    });
    expect(agents).toHaveLength(1);
    expect(agents[0].prompt).toBe('from A');
    expect(warnings.some((w) => w.includes('duplicate'))).toBe(true);
  });

  it('ignores plugins with no agents/ directory', () => {
    const root = tmpDir();
    const dir = path.join(root, 'no-agents-plugin');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'no-agents-plugin' }),
    );
    expect(loadPluginAgents([dir])).toEqual([]);
  });

  it('skips non-md files in agents/', () => {
    const root = tmpDir();
    const p = writePlugin(root, 'p', {
      'real.md': `---\nname: real\n---\nhello`,
      'notes.txt': `should be ignored`,
      'config.json': `{}`,
    });
    const agents = loadPluginAgents([p]);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('real');
  });

  it('sanitizes weird names from frontmatter', () => {
    const root = tmpDir();
    const p = writePlugin(root, 'p', {
      'weird.md': `---\nname: "Hello World!!"\n---\nbody`,
    });
    const agents = loadPluginAgents([p]);
    expect(agents[0].name).toBe('hello-world');
  });
});
