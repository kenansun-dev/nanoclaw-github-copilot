import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config-extensions.js', () => ({
  resolveAgentForChat: () => ({
    mode: 'sandbox',
    model: 'anthropic/claude-sonnet-4',
    name: 'Andy',
    triggerWord: '@Andy',
    hasOwnNumber: false,
    sandboxBackend: 'docker',
  }),
  isAgentGHC: () => false,
  getAgentSessionDir: () => '.claude',
  getAgentImage: () => 'nanoclaw-agent:latest',
  getAgentModelName: () => 'claude-sonnet-4',
  resolveGithubToken: () => undefined,
  resolveSessionDir: () => '.claude',
  resolveContainerImage: () => 'nanoclaw-agent:latest',
  resolveRunnerDir: () => 'agent-runner',
  buildProviderEnvArgs: () => ['-e', 'ANTHROPIC_API_KEY=placeholder'],
  buildProviderMounts: () => [],
  IS_GHC_PROVIDER: false,
  PROVIDER_SESSION_DIR: '.claude',
}));

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  ONECLI_URL: 'http://localhost:10254',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CREDENTIAL_PROXY_PORT: 3001,
  DEFAULT_TRIGGER: '@Andy',
  getTriggerPattern: () => /^@Andy/i,
  TRIGGER_PATTERN: /^@Andy/i,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  PACKAGE_ROOT: '/tmp/nanoclaw-test-pkg',
  AGENT_RUN_TIMEOUT_MS: 600000, // 10min
  IS_GHC_PROVIDER: false,
  PROVIDER_SESSION_DIR: '.claude',
  ONECLI_API_KEY: '',
  TIMEZONE: 'America/Los_Angeles',
  getConfig: () => ({ providers: {} }),
  resolveAgentForChat: () => ({
    model: 'github-copilot/claude-sonnet-4',
    name: 'Andy',
    mode: 'sandbox',
    sandboxBackend: 'docker',
  }),
  isAgentGHC: () => false,
  getAgentSessionDir: () => '.claude',
  getAgentImage: () => 'nanoclaw-agent:latest',
}));

// Mock logger
vi.mock('./log-extensions.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi.fn().mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types-extensions.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (configTimeout = 1800000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: 'Here is my response' }));
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// --- Wire-protocol invariants for OUTPUT_MARKER stream parser ---
//
// These tests pin the streaming parser behavior. Real-world bug class:
// stdout arrives as TCP-style chunks, so a marker can split across two
// `data` events. A naive parser that only looks at one chunk at a time
// would miss the marker entirely and resolve as 'no output -> error'
// even though the agent completed successfully. Parser uses
// `parseBuffer += chunk` + `indexOf` to handle this; these tests would
// catch a regression to per-chunk parsing.

describe('container-runner OUTPUT_MARKER stream parser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles a marker split across two stdout chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Split mid-marker. Naive per-chunk parser would never find either
    // marker because neither chunk contains a complete START..END pair.
    const json = JSON.stringify({
      status: 'success',
      result: 'split-payload',
      newSessionId: 'split-session',
    });
    const full = `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;
    const splitAt = OUTPUT_START_MARKER.length - 5; // mid-START marker
    fakeProc.stdout.push(full.slice(0, splitAt));
    await vi.advanceTimersByTimeAsync(5);
    // Parser must NOT have called onOutput yet (incomplete pair)
    expect(onOutput).not.toHaveBeenCalled();

    fakeProc.stdout.push(full.slice(splitAt));
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('split-session');
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: 'split-payload' }));
  });

  it('drains multiple markers arriving in a single chunk', async () => {
    // Long sessions emit one marker per assistant turn. The parser
    // loops `while (indexOf(START)) { ... }` to drain them all. A
    // regression to a single `if` would silently drop all but the
    // first marker.
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    const m = (id: string, sid: string) => {
      const json = JSON.stringify({
        status: 'success',
        result: id,
        newSessionId: sid,
      });
      return `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;
    };
    fakeProc.stdout.push(m('first', 's1') + m('second', 's2') + m('third', 's3'));
    await vi.advanceTimersByTimeAsync(20);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Final newSessionId reflects the LAST marker (per parser code
    // `if (parsed.newSessionId) newSessionId = parsed.newSessionId`).
    expect(result.newSessionId).toBe('s3');
    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(onOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({ result: 'first' }));
    expect(onOutput).toHaveBeenNthCalledWith(3, expect.objectContaining({ result: 'third' }));
  });

  it('logs and continues when a framed payload is invalid JSON', async () => {
    // Hardening: a corrupted/torn marker payload must NOT crash the
    // parser or stop processing of subsequent valid markers. Without
    // this, a single bad turn from the agent-runner could brick the
    // entire container session.
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Invalid JSON between markers, then a valid marker after it.
    const bad = `${OUTPUT_START_MARKER}\n{this is not json}\n${OUTPUT_END_MARKER}\n`;
    const goodJson = JSON.stringify({
      status: 'success',
      result: 'recovered',
      newSessionId: 'after-bad',
    });
    const good = `${OUTPUT_START_MARKER}\n${goodJson}\n${OUTPUT_END_MARKER}\n`;
    fakeProc.stdout.push(bad + good);
    await vi.advanceTimersByTimeAsync(20);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('after-bad');
    // Only the valid marker should have invoked onOutput.
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: 'recovered' }));
  });
});
