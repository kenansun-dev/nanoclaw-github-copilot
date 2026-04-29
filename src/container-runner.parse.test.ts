import { describe, it, expect } from 'vitest';
import { parseHostCopilotConfig } from './container-runner.js';

describe('parseHostCopilotConfig', () => {
  it('strips leading // comments and parses copilotTokens', () => {
    const raw = `// User settings belong in settings.json.\n{ "copilotTokens": { "user": "ghu_abc" }, "lastLoggedInUser": { "login": "u" } }\n`;
    const cfg = parseHostCopilotConfig(raw);
    expect((cfg.copilotTokens as Record<string,string>).user).toBe('ghu_abc');
  });

  it('parses plain JSON without comments', () => {
    expect(parseHostCopilotConfig('{"a":1}')).toEqual({ a: 1 });
  });

  it('throws on unrecoverable JSON so caller catches and falls back', () => {
    expect(() => parseHostCopilotConfig('not json')).toThrow();
  });

  it('handles indented // comment lines', () => {
    const raw = `  // indented\n{"x":2}`;
    expect(parseHostCopilotConfig(raw)).toEqual({ x: 2 });
  });
});
