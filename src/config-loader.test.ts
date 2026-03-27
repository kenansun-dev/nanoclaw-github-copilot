import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from './workspace.js';
import { loadConfig, saveConfig, readWorkspaceEnv } from './config-loader.js';

describe('config-loader', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-cfg-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig returns defaults when no config file', () => {
    const config = loadConfig();
    expect(config.assistant.name).toBe('Andy');
    expect(config.sandbox.image).toBe('nanoclaw-agent:latest');
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('loadConfig merges user config with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        assistant: { name: 'Bob' },
        channels: { telegram: { enabled: true } },
      }),
    );
    const config = loadConfig();
    expect(config.assistant.name).toBe('Bob');
    expect(config.assistant.triggerWord).toBe('@Andy'); // default preserved
    expect(config.channels.telegram.enabled).toBe(true);
  });

  it('loadConfig reads .env secrets', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'TELEGRAM_BOT_TOKEN=test-token-123\n',
    );
    const config = loadConfig();
    expect(config.channels.telegram.botToken).toBe('test-token-123');
    expect(config.channels.telegram.enabled).toBe(true); // auto-enabled
  });

  it('loadConfig merges mcp.json servers', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mcp.json'),
      JSON.stringify({
        myserver: {
          type: 'local',
          command: 'node',
          args: ['test.js'],
          tools: ['*'],
        },
      }),
    );
    const config = loadConfig();
    expect(config.mcp.servers.myserver).toBeDefined();
    expect(config.mcp.servers.myserver.command).toBe('node');
  });

  it('saveConfig strips secrets', () => {
    const config = loadConfig();
    config.channels.telegram.botToken = 'secret-token';
    config.channels.teams.appPassword = 'secret-pass';
    saveConfig(config);

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'nanoclaw.json'), 'utf-8'),
    );
    expect(saved.channels.telegram.botToken).toBeUndefined();
    expect(saved.channels.teams.appPassword).toBeUndefined();
  });

  it('readWorkspaceEnv parses .env correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      '# comment\nKEY1=value1\nKEY2="quoted value"\nKEY3=\n',
    );
    const env = readWorkspaceEnv();
    expect(env.KEY1).toBe('value1');
    expect(env.KEY2).toBe('quoted value');
    expect(env.KEY3).toBeUndefined(); // empty value
  });
});

describe('config model passthrough', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-model-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('model from config is accessible for container input', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        providers: {
          'github-copilot': { enabled: true, model: 'claude-sonnet-4.6' },
        },
      }),
    );
    const config = loadConfig();
    const model = config.providers['github-copilot']?.model;
    expect(model).toBe('claude-sonnet-4.6');
  });

  it('model defaults to claude-sonnet-4 when not specified', () => {
    const config = loadConfig();
    expect(config.providers['github-copilot'].model).toBe('claude-sonnet-4');
  });
});
