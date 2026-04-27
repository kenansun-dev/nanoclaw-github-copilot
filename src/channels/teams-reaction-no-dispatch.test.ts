import { describe, it, expect } from 'vitest';

/**
 * Regression test: Teams `messageReaction` activities (👍, ❤️, etc. on a
 * bot message) MUST NOT be forwarded to the agent as a chat message.
 *
 * Background (kenan repro 2026-04-27, Teams):
 *   - User reacts to a bot message → bot replies in chat for every
 *     reaction → noisy and unwanted.
 *   - Root cause: both wire paths (`handleIncomingRaw` for cert mode and
 *     `handleIncoming` for adapter mode) called `this.opts.onMessage(...)`
 *     with a synthesized `[user reacted with X]` body. Agent saw it as a
 *     turn and replied.
 *
 * Fix: log the reaction at info level for visibility but do NOT call
 * onMessage. Reactions are passive ack signals.
 *
 * Test strategy: same static-grep pattern used by
 * teams-file-consent.test.ts — TeamsChannel can't be cleanly instantiated
 * in unit tests (botbuilder adapter requires a real appId), so we read
 * the source and assert the handler shape.
 */

describe('Teams messageReaction must not dispatch to agent', () => {
  function loadTeamsSource(): string {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readFileSync(path.resolve(__dirname, 'teams.ts'), 'utf-8');
  }

  function extractMethodBody(src: string, header: string): string {
    const start = src.indexOf(header);
    expect(start, `header not found: ${header}`).toBeGreaterThan(0);
    const nextMethod = src.indexOf('\n  private ', start + 30);
    const nextAsync = src.indexOf('\n  async ', start + 30);
    const end =
      nextMethod > 0 && (nextAsync < 0 || nextMethod < nextAsync)
        ? nextMethod
        : nextAsync > 0
          ? nextAsync
          : src.length;
    return src.slice(start, end);
  }

  function reactionBlock(methodBody: string): string {
    const blockStart = methodBody.indexOf(
      "activity.type === 'messageReaction'",
    );
    expect(
      blockStart,
      'reaction handler block not found in method',
    ).toBeGreaterThan(0);
    // The handler should return; bound the block at the next `return;`
    // followed by a closing brace, which marks the end of the if-block.
    const ret = methodBody.indexOf('return;', blockStart);
    expect(ret).toBeGreaterThan(blockStart);
    return methodBody.slice(blockStart, ret + 'return;'.length);
  }

  for (const header of [
    'private async handleIncomingRaw(',
    'private async handleIncoming(',
  ]) {
    it(`${header}: reaction handler does not call onMessage`, () => {
      const src = loadTeamsSource();
      const body = extractMethodBody(src, header);
      const block = reactionBlock(body);

      // Must still log so we have a paper trail in the journal.
      expect(block).toContain("'Teams reaction received");

      // Must NOT call the dispatch path. Either spelling
      // (`this.opts.onMessage` or destructured) would regress.
      expect(block).not.toContain('onMessage(');
      expect(block).not.toContain('reacted with');
    });
  }
});
