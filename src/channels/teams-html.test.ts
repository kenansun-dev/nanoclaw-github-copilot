import { describe, it, expect } from 'vitest';
import { expandHtmlLinks } from './teams-html.js';

describe('expandHtmlLinks', () => {
  it('passes through plain text unchanged', () => {
    expect(expandHtmlLinks('hello world')).toBe('hello world');
    expect(expandHtmlLinks('')).toBe('');
  });

  it('expands a Word doc link with distinct label', () => {
    const input = 'check this <a href="https://contoso.sharepoint.com/foo.docx">foo.docx</a> please';
    expect(expandHtmlLinks(input)).toBe('check this foo.docx (https://contoso.sharepoint.com/foo.docx) please');
  });

  it('keeps URL only when label === URL (avoid duplication)', () => {
    const input = '<a href="https://example.com">https://example.com</a>';
    expect(expandHtmlLinks(input)).toBe('https://example.com');
  });

  it('handles attrs around href + nested tags in label', () => {
    const input = '<a target="_blank" href="https://example.com/x?y=1" rel="noopener"><span>Click <b>me</b></span></a>';
    expect(expandHtmlLinks(input)).toBe('Click me (https://example.com/x?y=1)');
  });

  it('handles multiple links in one message', () => {
    const input = '<a href="https://a.com">A</a> and <a href="https://b.com">B</a>';
    expect(expandHtmlLinks(input)).toBe('A (https://a.com) and B (https://b.com)');
  });

  it('returns href when label is empty', () => {
    expect(expandHtmlLinks('<a href="https://x.com"></a>')).toBe('https://x.com');
  });

  it('case-insensitive tag and attribute', () => {
    expect(expandHtmlLinks('<A HREF="https://x.com">x</A>')).toBe('x (https://x.com)');
  });

  it('skips fast when no <a tag present', () => {
    const input = 'no anchor here, even with <b>bold</b>';
    expect(expandHtmlLinks(input)).toBe(input);
  });
});
