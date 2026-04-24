import { describe, it, expect } from 'vitest';
import { normalizeShowThinking, formatThinkingForChannel } from './index.js';

describe('normalizeShowThinking', () => {
  it('returns "off" for undefined', () => {
    expect(normalizeShowThinking(undefined)).toBe('off');
  });
  it('returns "off" for false (legacy boolean)', () => {
    expect(normalizeShowThinking(false)).toBe('off');
  });
  it('returns "on" for true (legacy boolean)', () => {
    expect(normalizeShowThinking(true)).toBe('on');
  });
  it('returns "on" for "on"', () => {
    expect(normalizeShowThinking('on')).toBe('on');
  });
  it('returns "off" for "off"', () => {
    expect(normalizeShowThinking('off')).toBe('off');
  });
  it('returns "flash" for "flash"', () => {
    expect(normalizeShowThinking('flash')).toBe('flash');
  });
});

describe('formatThinkingForChannel', () => {
  it('returns null for empty/whitespace thinking', () => {
    expect(formatThinkingForChannel('', 'tg:123')).toBeNull();
    expect(formatThinkingForChannel('   ', 'tg:123')).toBeNull();
  });
  it('Telegram: emits expandable HTML blockquote', () => {
    const r = formatThinkingForChannel('hello', 'tg:123');
    expect(r).not.toBeNull();
    expect(r!.parseMode).toBe('HTML');
    expect(r!.text).toContain('<blockquote expandable>');
    expect(r!.text).toContain('🧠 Thinking:');
    expect(r!.text).toContain('hello');
  });
  it('Discord: emits markdown blockquote (no parseMode)', () => {
    const r = formatThinkingForChannel('hello\nworld', 'discord:123');
    expect(r).not.toBeNull();
    expect(r!.parseMode).toBeUndefined();
    expect(r!.text).toContain('🧠 Thinking:');
    expect(r!.text).toContain('> hello');
    expect(r!.text).toContain('> world');
  });
  it('Telegram: HTML-escapes thinking content', () => {
    const r = formatThinkingForChannel('<script>alert(1)</script>', 'tg:1');
    expect(r!.text).toContain('&lt;script&gt;');
    expect(r!.text).not.toContain('<script>');
  });
  it('truncates very long thinking with ...(truncated) suffix', () => {
    const long = 'x'.repeat(3000);
    const r = formatThinkingForChannel(long, 'discord:1');
    expect(r!.text).toContain('...(truncated)');
    // Should be near the 2000 cap, not the full 3000
    expect(r!.text.length).toBeLessThan(2200);
  });
});
