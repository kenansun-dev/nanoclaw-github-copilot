/**
 * Tests for env.ts — .env file parsing.
 * Tests for doctor.ts — system diagnostic checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from './workspace.js';
import { readEnvFile } from './env.js';
import { runDoctor } from './doctor.js';

// ─── readEnvFile ─────────────────────────────────────────────────────────────

describe('readEnvFile', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-env-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses key=value pairs', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nBAZ=qux\n');
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result.FOO).toBe('bar');
    expect(result.BAZ).toBe('qux');
  });

  it('only returns requested keys', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nSECRET=hidden\n');
    const result = readEnvFile(['FOO']);
    expect(result.FOO).toBe('bar');
    expect(result.SECRET).toBeUndefined();
  });

  it('strips double quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TOKEN="abc123"\n');
    const result = readEnvFile(['TOKEN']);
    expect(result.TOKEN).toBe('abc123');
  });

  it('strips single quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), "TOKEN='abc123'\n");
    const result = readEnvFile(['TOKEN']);
    expect(result.TOKEN).toBe('abc123');
  });

  it('skips comments', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '# comment\nFOO=bar\n');
    const result = readEnvFile(['FOO']);
    expect(result.FOO).toBe('bar');
  });

  it('skips empty lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '\n\nFOO=bar\n\n');
    const result = readEnvFile(['FOO']);
    expect(result.FOO).toBe('bar');
  });

  it('skips empty values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=\nBAR=value\n');
    const result = readEnvFile(['FOO', 'BAR']);
    expect(result.FOO).toBeUndefined(); // empty value skipped
    expect(result.BAR).toBe('value');
  });

  it('returns empty object when .env missing', () => {
    const envPath = path.join(tmpDir, '.env');
    if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
  });

  it('handles values with = signs', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'URL=https://example.com?a=1&b=2\n',
    );
    const result = readEnvFile(['URL']);
    expect(result.URL).toBe('https://example.com?a=1&b=2');
  });
});

// ─── runDoctor ───────────────────────────────────────────────────────────────

describe('runDoctor', () => {
  it('returns an array of CheckResults', () => {
    const results = runDoctor();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('each result has name, status, and message', () => {
    const results = runDoctor();
    for (const r of results) {
      expect(r.name).toBeTruthy();
      expect(['ok', 'warn', 'error']).toContain(r.status);
      expect(typeof r.message).toBe('string');
    }
  });

  it('checks Node.js version', () => {
    const results = runDoctor();
    const nodeCheck = results.find((r) =>
      r.name.toLowerCase().includes('node'),
    );
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('ok');
  });

  it('checks workspace exists', () => {
    const results = runDoctor();
    const wsCheck = results.find(
      (r) =>
        r.name.toLowerCase().includes('workspace') ||
        r.name.toLowerCase().includes('config'),
    );
    expect(wsCheck).toBeDefined();
  });
});
