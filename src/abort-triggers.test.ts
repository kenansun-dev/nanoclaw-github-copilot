import { describe, it, expect } from 'vitest';
import { isAbortRequestText, __ABORT_TRIGGERS } from './abort-triggers.js';

describe('isAbortRequestText', () => {
  it('returns false for empty/undefined', () => {
    expect(isAbortRequestText(undefined)).toBe(false);
    expect(isAbortRequestText(null)).toBe(false);
    expect(isAbortRequestText('')).toBe(false);
    expect(isAbortRequestText('   ')).toBe(false);
  });

  it('matches core English triggers', () => {
    expect(isAbortRequestText('stop')).toBe(true);
    expect(isAbortRequestText('STOP')).toBe(true);
    expect(isAbortRequestText('  Stop  ')).toBe(true);
    expect(isAbortRequestText('cancel')).toBe(true);
    expect(isAbortRequestText('abort')).toBe(true);
    expect(isAbortRequestText('interrupt')).toBe(true);
    expect(isAbortRequestText('esc')).toBe(true);
    expect(isAbortRequestText('halt')).toBe(true);
  });

  it('strips trailing punctuation', () => {
    expect(isAbortRequestText('stop!')).toBe(true);
    expect(isAbortRequestText('stop.')).toBe(true);
    expect(isAbortRequestText('stop?!')).toBe(true);
    expect(isAbortRequestText('stop，')).toBe(true);
    expect(isAbortRequestText('停止。')).toBe(true);
  });

  it('matches slash forms', () => {
    expect(isAbortRequestText('/stop')).toBe(true);
    expect(isAbortRequestText('/cancel')).toBe(true);
    expect(isAbortRequestText('/abort')).toBe(true);
  });

  it('matches CJK / multilingual triggers', () => {
    expect(isAbortRequestText('停')).toBe(true);
    expect(isAbortRequestText('停止')).toBe(true);
    expect(isAbortRequestText('取消')).toBe(true);
    expect(isAbortRequestText('中止')).toBe(true);
    expect(isAbortRequestText('やめて')).toBe(true);
    expect(isAbortRequestText('стоп')).toBe(true);
    expect(isAbortRequestText('остановись')).toBe(true);
    expect(isAbortRequestText('parar')).toBe(true);
    expect(isAbortRequestText('arrête')).toBe(true);
    expect(isAbortRequestText('stopp')).toBe(true);
  });

  it('does NOT match common false-positive phrases', () => {
    // These are normal conversational phrases that should NOT abort
    expect(isAbortRequestText('wait a sec')).toBe(false);
    expect(isAbortRequestText('exit the function')).toBe(false);
    expect(isAbortRequestText('please stop at the store on the way')).toBe(false);
    expect(isAbortRequestText('can you cancel my subscription?')).toBe(false);
    expect(isAbortRequestText('I want to stop this feature')).toBe(false);
    expect(isAbortRequestText('stop words in NLP')).toBe(false);
    expect(isAbortRequestText('the abort signal api')).toBe(false);
    expect(isAbortRequestText('hello')).toBe(false);
    expect(isAbortRequestText('hi there')).toBe(false);
  });

  it('does NOT match partial matches mid-sentence', () => {
    expect(isAbortRequestText('stop or go')).toBe(false);
    expect(isAbortRequestText('halt and catch fire')).toBe(false);
  });

  it('exposes trigger set for inspection', () => {
    expect(__ABORT_TRIGGERS.has('stop')).toBe(true);
    expect(__ABORT_TRIGGERS.has('wait')).toBe(false); // intentionally excluded
    expect(__ABORT_TRIGGERS.has('exit')).toBe(false); // intentionally excluded
  });
});
