import { describe, it, expect } from 'vitest';
import { normalizeShowThinking, formatThinkingForChannel, formatThinkingForFlash } from './index.js';

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

describe('formatThinkingForChannel (persistent on mode)', () => {
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
    expect(r!.text.length).toBeLessThan(2200);
  });
});

describe('formatThinkingForFlash (transient preview)', () => {
  it('returns null for empty thinking', () => {
    expect(formatThinkingForFlash('', 'tg:1')).toBeNull();
    expect(formatThinkingForFlash('   ', 'tg:1')).toBeNull();
  });
  it('Telegram: HTML italic, no blockquote, parseMode HTML', () => {
    const r = formatThinkingForFlash('hello', 'tg:1');
    expect(r).not.toBeNull();
    expect(r!.parseMode).toBe('HTML');
    expect(r!.text).toContain('<i>thinking…</i>');
    expect(r!.text).toContain('<i>hello</i>');
    expect(r!.text).not.toContain('blockquote');
    // Must not contain bare markdown that TG won't parse with parseMode=HTML
    expect(r!.text).not.toContain('_thinking');
  });
  it('Telegram: HTML-escapes content', () => {
    const r = formatThinkingForFlash('<script>x</script>', 'tg:1');
    expect(r!.text).toContain('&lt;script&gt;');
    // Raw <script>x must not appear as parsed HTML
    expect(r!.text).not.toMatch(/<script>x<\/script>/);
  });
  it('Discord: markdown italic, no parseMode', () => {
    const r = formatThinkingForFlash('hello world', 'discord:1');
    expect(r).not.toBeNull();
    expect(r!.parseMode).toBeUndefined();
    expect(r!.text).toContain('_thinking…_');
    expect(r!.text).toContain('_hello world_');
  });
  it('Discord: escapes underscore in content', () => {
    const r = formatThinkingForFlash('foo_bar', 'discord:1');
    expect(r!.text).toContain('foo\\_bar');
  });
  it('Teams/TUI/unknown: plain text, no markup leaking', () => {
    const r = formatThinkingForFlash('hello', 'teams:abc');
    expect(r).not.toBeNull();
    expect(r!.parseMode).toBeUndefined();
    expect(r!.text).toBe('🧠 thinking… hello');
    expect(r!.text).not.toContain('<i>');
    expect(r!.text).not.toContain('_thinking');
  });
  it('TUI plain too', () => {
    const r = formatThinkingForFlash('hi', 'tui:default');
    expect(r!.text).toBe('🧠 thinking… hi');
  });
  it('collapses multiline thinking into one line', () => {
    const r = formatThinkingForFlash('line1\nline2\n  line3', 'tg:1');
    expect(r!.text).not.toContain('\n');
    expect(r!.text).toContain('line1 line2 line3');
  });
  it('truncates with single ellipsis (no "...(truncated)" suffix)', () => {
    const long = 'x'.repeat(800);
    const r = formatThinkingForFlash(long, 'tg:1');
    expect(r!.text).toContain('…');
    expect(r!.text).not.toContain('(truncated)');
    expect(r!.text.length).toBeLessThan(800);
  });
});
