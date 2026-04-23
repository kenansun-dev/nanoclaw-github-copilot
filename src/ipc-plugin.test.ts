/**
 * Tests for handlePluginIpc — the host-side handler for the
 * `nanoclaw_plugin` MCP tool. Verifies request → response round-trips for
 * list / install / uninstall / marketplace_list, plus failure cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from './workspace.js';
import { handlePluginIpc } from './ipc.js';
import { saveConfig, loadConfig } from './config-loader.js';

describe('handlePluginIpc', () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `nanoclaw-test-pluginipc-${Date.now()}`,
  );
  const responseDir = path.join(tmpDir, 'responses');

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
    fs.mkdirSync(responseDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readResponse(requestId: string): any {
    const p = path.join(responseDir, `${requestId}.json`);
    expect(fs.existsSync(p)).toBe(true);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  it('list returns empty when no plugins/ dir', async () => {
    const requestId = 'req-list-empty';
    await handlePluginIpc({ action: 'list', requestId }, responseDir);
    const res = readResponse(requestId);
    expect(res.ok).toBe(true);
    expect(res.plugins).toEqual([]);
  });

  it('list returns installed plugins (root-level plugin.json)', async () => {
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(path.join(pluginsDir, 'foo'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'foo', 'plugin.json'),
      JSON.stringify({
        name: 'foo',
        version: '1.2.3',
        description: 'foo plugin',
        provider: 'acme',
      }),
    );
    const requestId = 'req-list-one';
    await handlePluginIpc({ action: 'list', requestId }, responseDir);
    const res = readResponse(requestId);
    expect(res.ok).toBe(true);
    expect(res.plugins).toEqual([
      {
        name: 'foo',
        version: '1.2.3',
        description: 'foo plugin',
        provider: 'acme',
      },
    ]);
  });

  it('list also reads .claude-plugin/plugin.json (CC layout)', async () => {
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(path.join(pluginsDir, 'bar', '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pluginsDir, 'bar', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bar', version: '0.1.0' }),
    );
    const requestId = 'req-list-cc';
    await handlePluginIpc({ action: 'list', requestId }, responseDir);
    const res = readResponse(requestId);
    expect(res.ok).toBe(true);
    expect(res.plugins[0].name).toBe('bar');
  });

  it('install rejects missing source', async () => {
    const requestId = 'req-install-no-source';
    await handlePluginIpc({ action: 'install', requestId }, responseDir);
    const res = readResponse(requestId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/source/i);
  });

  it('install with local-path source adds entry + fetches', async () => {
    const srcRoot = path.join(tmpDir, 'src-plugin');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'plugin.json'),
      JSON.stringify({ name: 'localfoo', version: '0.0.1' }),
    );
    const requestId = 'req-install-local';
    await handlePluginIpc(
      { action: 'install', source: srcRoot, requestId },
      responseDir,
    );
    const res = readResponse(requestId);
    expect(res.ok).toBe(true);
    expect(res.name).toBe('localfoo');
    expect(res.result.installed).toContain('localfoo');
    // Config should now declare it.
    const config = loadConfig();
    expect(
      config.plugins?.enabled?.find((e) => e.name === 'localfoo'),
    ).toBeTruthy();
    // Plugin dir should exist.
    expect(
      fs.existsSync(path.join(tmpDir, 'plugins', 'localfoo', 'plugin.json')),
    ).toBe(true);
  });

  it('install is idempotent (re-install skips existing)', async () => {
    const srcRoot = path.join(tmpDir, 'src-plugin-idem');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'plugin.json'),
      JSON.stringify({ name: 'idem', version: '0.0.1' }),
    );
    // First install
    await handlePluginIpc(
      { action: 'install', source: srcRoot, requestId: 'req-1' },
      responseDir,
    );
    // Second install
    await handlePluginIpc(
      { action: 'install', source: srcRoot, requestId: 'req-2' },
      responseDir,
    );
    const res2 = readResponse('req-2');
    expect(res2.ok).toBe(true);
    expect(res2.result.skipped).toContain('idem');
  });

  it('uninstall removes from config and disk', async () => {
    // Pre-seed install
    const srcRoot = path.join(tmpDir, 'src-uninst');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'plugin.json'),
      JSON.stringify({ name: 'rmme', version: '0.0.1' }),
    );
    await handlePluginIpc(
      { action: 'install', source: srcRoot, requestId: 'pre' },
      responseDir,
    );
    expect(fs.existsSync(path.join(tmpDir, 'plugins', 'rmme'))).toBe(true);

    // Now uninstall
    await handlePluginIpc(
      { action: 'uninstall', name: 'rmme', requestId: 'unreq' },
      responseDir,
    );
    const res = readResponse('unreq');
    expect(res.ok).toBe(true);
    expect(res.name).toBe('rmme');
    expect(fs.existsSync(path.join(tmpDir, 'plugins', 'rmme'))).toBe(false);
    const config = loadConfig();
    expect(config.plugins?.enabled?.find((e) => e.name === 'rmme')).toBeFalsy();
  });

  it('uninstall rejects missing name', async () => {
    await handlePluginIpc(
      { action: 'uninstall', requestId: 'badreq' },
      responseDir,
    );
    const res = readResponse('badreq');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name/i);
  });

  it('marketplace_list returns configured marketplaces', async () => {
    const config = loadConfig();
    config.plugins = {
      enabled: [],
      marketplaces: [
        { name: 'acme', source: 'https://github.com/acme/marketplace' },
      ],
      directories: [],
    };
    saveConfig(config);

    await handlePluginIpc(
      { action: 'marketplace_list', requestId: 'mreq' },
      responseDir,
    );
    const res = readResponse('mreq');
    expect(res.ok).toBe(true);
    expect(res.marketplaces).toHaveLength(1);
    expect(res.marketplaces[0].name).toBe('acme');
  });

  it('returns error for unknown action', async () => {
    await handlePluginIpc(
      { action: 'frobnicate', requestId: 'unkreq' },
      responseDir,
    );
    const res = readResponse('unkreq');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown/i);
  });
});
