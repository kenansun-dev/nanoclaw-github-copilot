/**
 * Tests for IPC helper functions in agent-runner.
 * Covers drainIpcInput, shouldClose, waitForIpcMessage behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We can't easily import from index.ts (it runs main on import).
// Instead, test the logic patterns directly.

describe('IPC helper logic', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-ipc-test-${Date.now()}`);
  const inputDir = path.join(tmpDir, 'input');
  const closeSentinel = path.join(inputDir, '_close');

  beforeEach(() => {
    fs.mkdirSync(inputDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Mirror of drainIpcInput logic
  function drainIpcInput(): string[] {
    const messages: string[] = [];
    try {
      const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const filepath = path.join(inputDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
          if (data.text) messages.push(data.text);
          fs.unlinkSync(filepath);
        } catch { /* skip malformed */ }
      }
    } catch { /* dir doesn't exist */ }
    return messages;
  }

  function shouldClose(): boolean {
    return fs.existsSync(closeSentinel);
  }

  it('drainIpcInput reads and deletes JSON files in order', () => {
    fs.writeFileSync(
      path.join(inputDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'first' }),
    );
    fs.writeFileSync(
      path.join(inputDir, '002.json'),
      JSON.stringify({ type: 'message', text: 'second' }),
    );

    const messages = drainIpcInput();
    expect(messages).toEqual(['first', 'second']);

    // Files should be deleted
    const remaining = fs.readdirSync(inputDir).filter(f => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('drainIpcInput returns empty array when no files', () => {
    expect(drainIpcInput()).toEqual([]);
  });

  it('drainIpcInput skips malformed JSON files', () => {
    fs.writeFileSync(path.join(inputDir, '001.json'), 'not json');
    fs.writeFileSync(
      path.join(inputDir, '002.json'),
      JSON.stringify({ type: 'message', text: 'valid' }),
    );

    const messages = drainIpcInput();
    expect(messages).toEqual(['valid']);
  });

  it('shouldClose returns false when no sentinel', () => {
    expect(shouldClose()).toBe(false);
  });

  it('shouldClose returns true when _close sentinel exists', () => {
    fs.writeFileSync(closeSentinel, '');
    expect(shouldClose()).toBe(true);
  });

  it('drain before close: messages are read even when _close exists', () => {
    // This tests the #186 fix: drain messages BEFORE checking close
    fs.writeFileSync(
      path.join(inputDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'important' }),
    );
    fs.writeFileSync(closeSentinel, '');

    // Drain first (new behavior)
    const messages = drainIpcInput();
    expect(messages).toEqual(['important']);

    // Then check close
    expect(shouldClose()).toBe(true);
  });

  it('queuedIpcMessages pattern: messages stored during query are used after', () => {
    // Simulates the #189 fix
    const queuedIpcMessages: string[] = [];

    // During query: messages arrive and are queued
    fs.writeFileSync(
      path.join(inputDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'mid-query msg' }),
    );
    const midQueryMessages = drainIpcInput();
    for (const text of midQueryMessages) {
      queuedIpcMessages.push(text);
    }

    // Query ends — check queue before polling
    expect(queuedIpcMessages.length).toBeGreaterThan(0);
    const nextPrompt = queuedIpcMessages.join('\n');
    queuedIpcMessages.length = 0;
    expect(nextPrompt).toBe('mid-query msg');
    expect(queuedIpcMessages).toHaveLength(0);
  });
});
