import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpWorkspace = path.join(os.tmpdir(), `nanoclaw-e2e-${Date.now()}`);
const cliPath = path.join(process.cwd(), 'bin', 'nanoclaw.ts');
const runCli = (args: string) =>
  execSync(`npx tsx ${cliPath} --workspace ${tmpWorkspace} ${args} 2>&1`, {
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, NANOCLAW_WORKSPACE: tmpWorkspace },
  });

describe('E2E: nanoclaw CLI', () => {
  afterAll(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('init creates workspace', () => {
    const output = runCli('init');
    expect(fs.existsSync(path.join(tmpWorkspace, 'nanoclaw.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpWorkspace, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpWorkspace, 'AGENT.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpWorkspace, 'skills'))).toBe(true);
  });

  it('nanoclaw.json is valid', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpWorkspace, 'nanoclaw.json'), 'utf-8'),
    );
    expect(config.agents).toBeDefined();
    expect(config.channels).toBeDefined();
    expect(config.sandbox).toBeDefined();
  });

  it('config get works', () => {
    const output = runCli('config get');
    expect(output).toContain('agents');
  });

  it('doctor runs without crashing', () => {
    expect(() => runCli('doctor')).not.toThrow();
  });

  it('chat list runs without crashing', () => {
    expect(() => runCli('chat list')).not.toThrow();
  });

  it('channel list runs without crashing', () => {
    expect(() => runCli('channel list')).not.toThrow();
  });

  it('status shows workspace', () => {
    const output = runCli('status');
    expect(output).toContain(tmpWorkspace);
  });

  it('--help shows usage', () => {
    const output = runCli('--help');
    expect(output).toContain('nanoclaw');
    expect(output).toContain('init');
    expect(output).toContain('start');
  });
});
