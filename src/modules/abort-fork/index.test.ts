import { describe, expect, it } from 'vitest';

import { abortFork } from './index.js';

describe('abortFork module skeleton', () => {
  it('re-exports isAbortRequestText', () => {
    expect(typeof abortFork.isAbortRequestText).toBe('function');
  });

  it('returns true for canonical abort triggers', () => {
    expect(abortFork.isAbortRequestText('stop')).toBe(true);
    expect(abortFork.isAbortRequestText('cancel')).toBe(true);
    expect(abortFork.isAbortRequestText('停')).toBe(true);
    expect(abortFork.isAbortRequestText('/abort')).toBe(true);
  });

  it('returns false for normal conversational text', () => {
    expect(abortFork.isAbortRequestText('please continue')).toBe(false);
    expect(abortFork.isAbortRequestText('')).toBe(false);
    expect(abortFork.isAbortRequestText(null)).toBe(false);
    expect(abortFork.isAbortRequestText(undefined)).toBe(false);
  });

  it('normalizes whitespace and trailing punctuation', () => {
    expect(abortFork.isAbortRequestText('  STOP!  ')).toBe(true);
    expect(abortFork.isAbortRequestText('cancel.')).toBe(true);
    expect(abortFork.isAbortRequestText('停。')).toBe(true);
  });
});
