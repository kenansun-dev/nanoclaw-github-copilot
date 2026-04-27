import { describe, it, expect } from 'vitest';
import {
  applyOnModeThinkingPrepend,
  formatThinkingForChannel,
} from './index.js';

/**
 * Bug 2 (kenan TG repro 2026-04-25 18:06):
 *   In `on` mode, a single agent query that contains a tool call emits
 *   multiple `partial=false` result events (pre-tool final + post-tool
 *   final). Each event carries the SDK's accumulated `result.thinking`.
 *   The legacy code prepended thinking on every final, so users saw the
 *   thinking block rendered twice (or N times for N-tool turns).
 *
 * Fix: applyOnModeThinkingPrepend respects an `alreadyPrepended` flag.
 *   The dispatcher caller maintains `thinkingPrependedThisQuery: boolean`,
 *   resets it on `queryBoundaryPending`, and passes the current value in.
 */
describe('applyOnModeThinkingPrepend (on-mode dedup)', () => {
  const tg = 'tg:123';

  it('prepends on first final of a query', () => {
    const formatted = formatThinkingForChannel('reasoning step 1', tg);
    const out = applyOnModeThinkingPrepend({
      thinking: 'reasoning step 1',
      resultText: 'tool call output',
      alreadyPrepended: false,
      formatted,
    });
    expect(out.prepended).toBe(true);
    expect(out.resultText).toContain('🧠 Thinking:');
    expect(out.resultText).toContain('reasoning step 1');
    expect(out.resultText).toContain('tool call output');
  });

  it('does NOT re-prepend on second final of same query (the bug)', () => {
    // Simulate: pre-tool final already prepended, post-tool final arrives
    // with the SDK's accumulated thinking (now longer).
    const formatted = formatThinkingForChannel(
      'reasoning step 1\nreasoning step 2 (after tool)',
      tg,
    );
    const out = applyOnModeThinkingPrepend({
      thinking: 'reasoning step 1\nreasoning step 2 (after tool)',
      resultText: 'final answer text',
      alreadyPrepended: true,
      formatted,
    });
    expect(out.prepended).toBe(true); // stays true
    expect(out.resultText).toBe('final answer text'); // unchanged
    expect(out.parseMode).toBeUndefined(); // not re-set
  });

  it('handles full simulated turn: prepend once, skip subsequent finals', () => {
    let prepended = false;
    let parseMode: 'HTML' | 'Markdown' | undefined;
    const finals = [
      { thinking: 'step 1', result: 'pre-tool answer' },
      { thinking: 'step 1\nstep 2', result: 'mid-tool answer' },
      { thinking: 'step 1\nstep 2\nstep 3', result: 'final answer' },
    ];
    const outputs: string[] = [];
    for (const f of finals) {
      const formatted = formatThinkingForChannel(f.thinking, tg);
      const merged = applyOnModeThinkingPrepend({
        thinking: f.thinking,
        resultText: f.result,
        alreadyPrepended: prepended,
        formatted,
      });
      if (merged.prepended && !prepended) {
        parseMode = merged.parseMode;
        prepended = true;
      }
      outputs.push(merged.resultText);
    }
    // Only first output has the thinking block
    expect(outputs[0]).toContain('🧠 Thinking:');
    expect(outputs[1]).not.toContain('🧠 Thinking:');
    expect(outputs[2]).not.toContain('🧠 Thinking:');
    // Final answer text preserved untouched on subsequent finals
    expect(outputs[1]).toBe('mid-tool answer');
    expect(outputs[2]).toBe('final answer');
    // parseMode captured from first prepend
    expect(parseMode).toBe('HTML');
  });

  it('skips when thinking is empty', () => {
    const out = applyOnModeThinkingPrepend({
      thinking: undefined,
      resultText: 'answer only',
      alreadyPrepended: false,
      formatted: null,
    });
    expect(out.prepended).toBe(false);
    expect(out.resultText).toBe('answer only');
  });

  it('preserves caller flag when formatted is null (whitespace thinking)', () => {
    const formatted = formatThinkingForChannel('   ', tg); // -> null
    const out = applyOnModeThinkingPrepend({
      thinking: '   ',
      resultText: 'answer',
      alreadyPrepended: false,
      formatted,
    });
    expect(out.prepended).toBe(false);
    expect(out.resultText).toBe('answer');
  });

  it('Discord: prepend uses markdown blockquote, no parseMode', () => {
    const formatted = formatThinkingForChannel('hi', 'discord:99');
    const out = applyOnModeThinkingPrepend({
      thinking: 'hi',
      resultText: 'answer',
      alreadyPrepended: false,
      formatted,
    });
    expect(out.prepended).toBe(true);
    expect(out.parseMode).toBeUndefined();
    expect(out.resultText).toContain('> hi');
    expect(out.resultText).toContain('answer');
  });
});
