import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveGithubToken } from './github-token-provider.js';

/**
 * These tests verify the snake_case + camelCase schema compat for
 * ~/.copilot/config.json. The newer copilot CLI (verified on rpi5
 * 2026-04-24) writes camelCase keys (`copilotTokens`, etc.). Older
 * versions used snake_case. Both must work.
 */
describe('resolveGithubToken (~/.copilot/config.json schema compat)', () => {
  let tmpHome: string;
  let prevEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-token-'));
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true });
    prevEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reads token from snake_case copilot_tokens (legacy CLI)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({
        copilot_tokens: { 'github.com': 'ghu_legacy_token_12345' },
      }),
    );
    expect(resolveGithubToken()).toBe('ghu_legacy_token_12345');
  });

  it('reads token from camelCase copilotTokens (new CLI, rpi5 2026-04-24)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({
        copilotTokens: { 'github.com': 'ghu_new_token_67890' },
        lastLoggedInUser: { login: 'kenansun' },
      }),
    );
    expect(resolveGithubToken()).toBe('ghu_new_token_67890');
  });

  it('prefers camelCase when both shapes are present', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({
        copilot_tokens: { 'github.com': 'old_token' },
        copilotTokens: { 'github.com': 'new_token' },
      }),
    );
    expect(resolveGithubToken()).toBe('new_token');
  });

  it('returns undefined when file exists but no token bag', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({ firstLaunchAt: 123 }),
    );
    expect(resolveGithubToken()).toBeUndefined();
  });

  it('env COPILOT_GITHUB_TOKEN beats file', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({ copilotTokens: { 'github.com': 'file_token' } }),
    );
    process.env.COPILOT_GITHUB_TOKEN = 'env_token';
    expect(resolveGithubToken()).toBe('env_token');
  });
});
