/**
 * Real unit tests for IPC helpers used by the GHC agent runner.
 *
 * History: Before 2026-05-01 this file was fake-coverage — it
 * re-implemented `drainIpcInput` and `shouldClose` inline, then asserted
 * against the local copy. Deleting prod code did not break the test.
 *
 * Now the helpers live in container/agent-runner-ghc/src/ipc-helpers.ts
 * and we import them here. The test module also resolves to a fresh
 * temp-dir-bound IpcHelpers instance per test so we exercise the real
 * filesystem path the runner uses in production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Real implementation under test.
import { makeIpcHelpers } from '../container/agent-runner-ghc/src/ipc-helpers.js';

describe('ipc-helpers (real module under test)', () => {
  let tmpDir: string;
  let inputDir: string;
  let closeSentinel: string;
  let logs: string[];
  let helpers: ReturnType<typeof makeIpcHelpers>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-real-'));
    inputDir = path.join(tmpDir, 'input');
    closeSentinel = path.join(inputDir, '_close');
    fs.mkdirSync(inputDir, { recursive: true });
    logs = [];
    helpers = makeIpcHelpers({
      inputDir,
      closeSentinel,
      pollMs: 5,
      log: (m) => logs.push(m),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMsg(name: string, body: unknown) {
    fs.writeFileSync(path.join(inputDir, name), JSON.stringify(body));
  }

  // ── drain ──────────────────────────────────────────────────────────────

  it('drainIpcInput reads and deletes JSON files in name order', () => {
    writeMsg('001.json', { type: 'message', text: 'first' });
    writeMsg('002.json', { type: 'message', text: 'second' });

    const out = helpers.drainIpcInput();
    expect(out).toEqual(['first', 'second']);
    expect(fs.readdirSync(inputDir).filter((f) => f.endsWith('.json'))).toEqual(
      [],
    );
  });

  it('drainIpcInput returns [] when input dir is empty', () => {
    expect(helpers.drainIpcInput()).toEqual([]);
  });

  it('drainIpcInput skips and removes malformed JSON, preserving valid messages', () => {
    fs.writeFileSync(path.join(inputDir, '001.json'), 'not json');
    writeMsg('002.json', { type: 'message', text: 'valid' });

    const out = helpers.drainIpcInput();
    expect(out).toEqual(['valid']);
    // Bad file removed too so it does not infinite-loop on next poll.
    expect(fs.existsSync(path.join(inputDir, '001.json'))).toBe(false);
    expect(logs.some((l) => l.includes('Failed to process input file'))).toBe(
      true,
    );
  });

  it('drainIpcInput ignores entries without type=message OR without text', () => {
    writeMsg('001.json', { type: 'notice', text: 'ignored' });
    writeMsg('002.json', { type: 'message' }); // no text
    writeMsg('003.json', { type: 'message', text: '' }); // empty
    writeMsg('004.json', { type: 'message', text: 'kept' });

    const out = helpers.drainIpcInput();
    expect(out).toEqual(['kept']);
  });

  it('drainIpcInput auto-creates inputDir if missing (idempotent)', () => {
    fs.rmSync(inputDir, { recursive: true, force: true });
    expect(fs.existsSync(inputDir)).toBe(false);
    expect(helpers.drainIpcInput()).toEqual([]);
    expect(fs.existsSync(inputDir)).toBe(true);
  });

  // ── shouldClose ────────────────────────────────────────────────────────

  it('shouldClose returns false when no sentinel', () => {
    expect(helpers.shouldClose()).toBe(false);
  });

  it('shouldClose returns true once and consumes the sentinel', () => {
    fs.writeFileSync(closeSentinel, '');
    expect(helpers.shouldClose()).toBe(true);
    // Sentinel must be removed so a subsequent poll-iteration does not
    // double-close the session.
    expect(fs.existsSync(closeSentinel)).toBe(false);
    expect(helpers.shouldClose()).toBe(false);
  });

  // ── waitForIpcMessage (real timing, real race) ─────────────────────────

  it('waitForIpcMessage resolves with joined messages when files arrive', async () => {
    writeMsg('001.json', { type: 'message', text: 'a' });
    writeMsg('002.json', { type: 'message', text: 'b' });
    const msg = await helpers.waitForIpcMessage();
    expect(msg).toBe('a\nb');
  });

  it('waitForIpcMessage resolves null when only close sentinel arrives', async () => {
    fs.writeFileSync(closeSentinel, '');
    const msg = await helpers.waitForIpcMessage();
    expect(msg).toBeNull();
  });

  // This is the regression test for #186/#189 and the "drain BEFORE close
  // check" ordering. If a race lets the close sentinel arrive in the SAME
  // poll iteration as a final message, we must still deliver the message,
  // not silently drop it.
  it('drain-before-close: pending message wins over concurrent close sentinel', async () => {
    writeMsg('001.json', { type: 'message', text: 'last words' });
    fs.writeFileSync(closeSentinel, '');

    const msg = await helpers.waitForIpcMessage();
    expect(msg).toBe('last words');
  });

  it('waitForIpcMessage polls and picks up a late-arriving message', async () => {
    setTimeout(() => writeMsg('001.json', { type: 'message', text: 'late' }), 20);
    const msg = await helpers.waitForIpcMessage();
    expect(msg).toBe('late');
  });

  it('waitForIpcMessage exits cleanly when close arrives during polling', async () => {
    setTimeout(() => fs.writeFileSync(closeSentinel, ''), 20);
    const msg = await helpers.waitForIpcMessage();
    expect(msg).toBeNull();
  });
});
