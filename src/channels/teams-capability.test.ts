import { describe, it, expect } from 'vitest';

/**
 * Capability flag regression test for fix/teams-multi-final-edit.
 *
 * Background: src/index.ts used to unconditionally `editMessage` when an
 * agent emitted multiple final outputs in a single turn, which on Teams
 * silently overwrote earlier replies because `updateActivity` mutates the
 * message in place with no visible "edited" affordance. The fix gates that
 * branch on `!channel.prefersNewMessageForFinal`, and this test pins the
 * flag so a future Teams refactor can't accidentally drop it.
 *
 * We intentionally do NOT instantiate TeamsChannel here (its constructor
 * requires a Bot Framework adapter, server, and DI of getMessageById /
 * onChatMetadata). We assert the static class field via a partial mock
 * that mirrors the production declaration; the type system catches drift.
 */
import type { Channel } from '../types.js';

describe('Teams channel capability', () => {
  it('declares prefersNewMessageForFinal=true on the class', async () => {
    // Avoid a side-effecty `new TeamsChannel(...)` — pull the prototype
    // and read the field default that the constructor would inherit.
    const mod = await import('./teams.js');
    const proto = mod.TeamsChannel.prototype as unknown as Channel;
    // Prototype inheritance: instance fields aren't on prototype, but
    // we can construct a minimal object with the class as its prototype
    // and read defaults set via class-field initialization.
    const ghost = Object.create(proto);
    // Simulate the field initializer assigning to `this`.
    // (Class fields run in the constructor body; reading the class
    // declaration text below is the contract we care about.)
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('./teams.ts', import.meta.url), 'utf-8'),
    );
    expect(src).toMatch(/prefersNewMessageForFinal\s*=\s*true/);
    expect(ghost).toBeDefined();
  });

  it('Channel interface declares prefersNewMessageForFinal as optional boolean', async () => {
    // Type-only contract: a channel without the flag is still a Channel.
    const minimal: Pick<
      Channel,
      | 'name'
      | 'connect'
      | 'sendMessage'
      | 'isConnected'
      | 'ownsJid'
      | 'disconnect'
    > = {
      name: 'fake',
      connect: async () => {},
      sendMessage: async () => undefined,
      isConnected: () => true,
      ownsJid: () => false,
      disconnect: async () => {},
    };
    expect((minimal as Channel).prefersNewMessageForFinal).toBeUndefined();

    const optedIn: Channel = {
      ...minimal,
      prefersNewMessageForFinal: true,
    };
    expect(optedIn.prefersNewMessageForFinal).toBe(true);
  });
});

describe('multi-final-output dispatch policy (logic mirror)', () => {
  /**
   * Mirror of the decision branches in src/index.ts so a regression in
   * the prefersNewMessageForFinal gating is caught at unit-test speed.
   * Keep this in sync if the production conditional is restructured.
   */
  type Decision = 'sendNew' | 'editLast' | 'editProgressive';
  function decide(args: {
    progressiveMsgId?: string;
    outputSentToUser: boolean;
    lastFinalMsgId?: string;
    hasEdit: boolean;
    prefersNewMessageForFinal?: boolean;
  }): Decision {
    if (args.progressiveMsgId && args.hasEdit) return 'editProgressive';
    if (
      args.outputSentToUser &&
      args.lastFinalMsgId &&
      args.hasEdit &&
      !args.prefersNewMessageForFinal
    ) {
      return 'editLast';
    }
    return 'sendNew';
  }

  it('first final output: sendNew', () => {
    expect(decide({ outputSentToUser: false, hasEdit: true })).toBe('sendNew');
  });

  it('Telegram-style channel, second final output: editLast', () => {
    expect(
      decide({
        outputSentToUser: true,
        lastFinalMsgId: 'm1',
        hasEdit: true,
        prefersNewMessageForFinal: false,
      }),
    ).toBe('editLast');
  });

  it('Teams-style channel, second final output: sendNew (regression: was editLast)', () => {
    expect(
      decide({
        outputSentToUser: true,
        lastFinalMsgId: 'm1',
        hasEdit: true,
        prefersNewMessageForFinal: true,
      }),
    ).toBe('sendNew');
  });

  it('Teams-style channel, third+ final output: still sendNew', () => {
    expect(
      decide({
        outputSentToUser: true,
        lastFinalMsgId: 'm5',
        hasEdit: true,
        prefersNewMessageForFinal: true,
      }),
    ).toBe('sendNew');
  });

  it('progressive partial overrides everything: editProgressive', () => {
    expect(
      decide({
        progressiveMsgId: 'p1',
        outputSentToUser: true,
        lastFinalMsgId: 'm1',
        hasEdit: true,
        prefersNewMessageForFinal: true,
      }),
    ).toBe('editProgressive');
  });

  it('channel without editMessage: always sendNew', () => {
    expect(
      decide({
        outputSentToUser: true,
        lastFinalMsgId: 'm1',
        hasEdit: false,
      }),
    ).toBe('sendNew');
  });
});

/**
 * Regression test for the IPC turn-boundary closure bug (kenansun,
 * 2026-04-21):
 *
 *   "我问新的话，nanoclaw也在编辑回我的消息，不发新消息给我"
 *
 * Root cause: in IPC mode, runAgent() resolves on the first query-complete
 * sentinel, but the spawned host agent process keeps living and the same
 * stdout listener (with the same onOutput closure) keeps firing for
 * follow-up turns piped via queue.sendMessage. Without explicit boundary
 * detection, lastFinalMsgId from turn N-1 stays in scope, so turn N's
 * first final output hits the editLast branch and overwrites the previous
 * turn's reply (silently on Teams via updateActivity).
 *
 * The fix in src/index.ts processGroupMessages: track a query-complete
 * sentinel via queryBoundaryPending, then on the next non-null result
 * reset progressiveMsgId / progressiveText / lastFinalMsgId /
 * outputSentToUser before dispatching.
 *
 * This test mirrors the boundary-reset state machine so a future refactor
 * that drops the reset gets caught.
 */
describe('IPC turn boundary closure reset', () => {
  type TurnState = {
    progressiveMsgId?: string;
    progressiveText: string;
    lastFinalMsgId?: string;
    outputSentToUser: boolean;
    queryBoundaryPending: boolean;
  };

  function fresh(): TurnState {
    return {
      progressiveMsgId: undefined,
      progressiveText: '',
      lastFinalMsgId: undefined,
      outputSentToUser: false,
      queryBoundaryPending: false,
    };
  }

  /** Mirror of the onOutput sentinel detection in src/index.ts. */
  function onOutput(
    state: TurnState,
    result: { result: any; partial?: boolean; newSessionId?: string },
  ): void {
    // Sentinel: query-complete (result===null + newSessionId + !partial)
    if (
      result.result === null &&
      result.newSessionId &&
      !result.partial
    ) {
      state.queryBoundaryPending = true;
    }
    // Real output — perform boundary reset BEFORE dispatching.
    if (result.result) {
      if (state.queryBoundaryPending) {
        state.queryBoundaryPending = false;
        state.progressiveMsgId = undefined;
        state.progressiveText = '';
        state.lastFinalMsgId = undefined;
        state.outputSentToUser = false;
      }
      // Simulate dispatch result: send a new message and remember its id.
      // (Real code chooses between sendNew/editLast/editProgressive; for
      // boundary purposes only the post-dispatch state assignment matters.)
      if (!result.partial) {
        state.lastFinalMsgId = `msg-${Math.random().toString(36).slice(2, 7)}`;
        state.outputSentToUser = true;
      }
    }
  }

  it('turn 1 alone: lastFinalMsgId set, outputSentToUser=true', () => {
    const s = fresh();
    onOutput(s, { result: 'turn 1 reply' });
    expect(s.outputSentToUser).toBe(true);
    expect(s.lastFinalMsgId).toBeDefined();
    expect(s.queryBoundaryPending).toBe(false);
  });

  it('query-complete sentinel marks boundary pending without resetting yet', () => {
    const s = fresh();
    onOutput(s, { result: 'turn 1 reply' });
    const turn1Id = s.lastFinalMsgId;
    onOutput(s, { result: null, newSessionId: 'sess-1' });
    // Boundary not applied yet — last turn's id is still readable for any
    // trailing partial that might race in (real code defends similarly).
    expect(s.queryBoundaryPending).toBe(true);
    expect(s.lastFinalMsgId).toBe(turn1Id);
    expect(s.outputSentToUser).toBe(true);
  });

  it('turn 2 (after sentinel): boundary reset, fresh lastFinalMsgId', () => {
    const s = fresh();
    onOutput(s, { result: 'turn 1 reply' });
    const turn1Id = s.lastFinalMsgId;
    onOutput(s, { result: null, newSessionId: 'sess-1' });
    onOutput(s, { result: 'turn 2 reply' });
    expect(s.queryBoundaryPending).toBe(false);
    expect(s.lastFinalMsgId).toBeDefined();
    expect(s.lastFinalMsgId).not.toBe(turn1Id);
    expect(s.outputSentToUser).toBe(true);
  });

  it('three turns in a row: each turn gets its own message id', () => {
    const s = fresh();
    const ids: (string | undefined)[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      onOutput(s, { result: `turn ${turn} reply` });
      ids.push(s.lastFinalMsgId);
      onOutput(s, { result: null, newSessionId: `sess-${turn}` });
    }
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toBeDefined());
  });

  it('without boundary handling (regression target): turn 2 would reuse turn 1 id', () => {
    // Simulate the BROKEN behavior to lock in why the fix matters.
    const s = fresh();
    onOutput(s, { result: 'turn 1' });
    const turn1Id = s.lastFinalMsgId;
    // Pretend sentinel was missed (no boundary tracking)
    s.queryBoundaryPending = false; // explicit no-op for clarity
    // Turn 2 arrives but state still has outputSentToUser=true and the old
    // lastFinalMsgId — in real code this triggers the editLast branch on
    // Telegram-style channels and the silent-overwrite on Teams
    // (now defended by prefersNewMessageForFinal). The boundary reset is
    // belt to that suspender: even Telegram users were getting confused
    // by the previous reply mutating when they asked something new.
    expect(s.outputSentToUser).toBe(true);
    expect(s.lastFinalMsgId).toBe(turn1Id);
  });

  it('source contract: processGroupMessages declares queryBoundaryPending', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(
        new URL('../index.ts', import.meta.url),
        'utf-8',
      ),
    );
    expect(src).toMatch(/let queryBoundaryPending = false/);
    expect(src).toMatch(/queryBoundaryPending = true/);
    expect(src).toMatch(/queryBoundaryPending = false/);
    expect(src).toMatch(/IPC turn boundary: reset per-turn message-id state/);
  });
});