import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Activity } from 'botbuilder';

/**
 * Regression tests for fix/2026-04-23-teams-typing-during-stream (PR #23).
 *
 * Background
 * ----------
 * After PR #20 (e783494) added native Teams streaming, kenan reported
 * 'Sorry, something went wrong.' interleaved with real agent output:
 *
 *   > Sorry, something went wrong.
 *   > Good, I can see 19 changed files. Let me read the key ones in parallel.
 *   > Sorry, something went wrong.
 *   > Now let me check the notify template and release pipeline quickly.
 *   > Sorry, something went wrong.
 *
 * Logs showed the matching error:
 *
 *   ERROR Teams adapter turn error
 *     err: "Only start streaming and continue streaming types are allowed
 *           as a typing activity"
 *
 * Root cause
 * ----------
 * The shared `setTyping(jid, true)` keepalive in src/channels/teams.ts
 * sends a bare `{type:'typing'}` activity every 3 seconds while the
 * agent is thinking. Once the streaming dispatcher has bootstrapped a
 * stream by sending `streamType:'informative'`, the Teams server puts
 * the conversation in stream-mode and rejects every subsequent typing
 * activity that does not carry a `streaminfo` entity. The reject is
 * caught by `adapter.onTurnError`, which then `sendActivity('Sorry,
 * something went wrong.')`s the user.
 *
 * String similarity to PR #20: PR #20 fixed the SAME error text but on
 * the dispatcher path (first chunk going out as `streaming` instead of
 * `informative`). This bug is on the DIFFERENT keepalive path that PR
 * #20 didn't touch. Both fixes are needed.
 *
 * Fix
 * ---
 * 1. TeamsChannel tracks `streamingActiveJids: Set<string>`.
 * 2. `streamMessage(jid)` adds jid to set on entry; the returned
 *    StreamHandle clears it in both `end()` and `cancel()` via a
 *    finally block.
 * 3. `setTyping(jid, true)` early-returns when jid is in the set
 *    (still clears any in-flight interval first so a stale
 *    keepalive from a prior turn is torn down).
 * 4. `markStreamingActive` also tears down any in-flight keepalive
 *    interval directly, defending against races where the dispatcher
 *    opens a stream while a previous turn's keepalive is still firing.
 * 5. `onTurnError` filters known-benign streaming wire rejects to
 *    log-only (no 'Sorry' user notice) so a single race-window slip
 *    doesn't surface to the user.
 *
 * Tests
 * -----
 * We don't fully instantiate `TeamsChannel` (constructor needs a Bot
 * Framework adapter, HTTP server, and DI of getMessageById etc.). We
 * build a thin harness that uses the real source text where useful
 * and a minimal in-memory mock to exercise the keepalive gate.
 */

describe('Teams: typing keepalive during native streaming', () => {
  // ---------- Source-text contracts (catches edits dropping the gate) ----------

  it('TeamsChannel declares streamingActiveJids field', async () => {
    const src = await fs.readFile(
      new URL('./teams.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toMatch(/streamingActiveJids\s*=\s*new Set<string>\(\)/);
  });

  it('setTyping early-returns when jid is in streamingActiveJids', async () => {
    const src = await fs.readFile(
      new URL('./teams.ts', import.meta.url),
      'utf-8',
    );
    // The gate must be after `if (!isTyping) return;` and before the
    // sendAction definition. We assert the gate text exists and is in
    // the setTyping function.
    const setTypingMatch = src.match(
      /async setTyping\([^)]*\):[^{]*\{[\s\S]*?\n\s\s\}/,
    );
    expect(setTypingMatch, 'setTyping function found').toBeTruthy();
    expect(setTypingMatch![0]).toMatch(
      /this\.streamingActiveJids\.has\(jid\)\)\s*return/,
    );
  });

  it('streamMessage marks the jid active and StreamHandle clears it on end/cancel', async () => {
    const src = await fs.readFile(
      new URL('./teams.ts', import.meta.url),
      'utf-8',
    );
    // The streamMessage method must call markStreamingActive on its jid.
    expect(src).toMatch(/markStreamingActive\(jid\)/);
    // And the wrapped end/cancel must call markStreamingInactive in
    // a finally block.
    expect(src).toMatch(/session\.end\s*=\s*async/);
    expect(src).toMatch(/session\.cancel\s*=\s*async/);
    expect(src).toMatch(/clearActive[^a-zA-Z]/);
    // markStreamingInactive must also tear down typingIntervals so a
    // stale keepalive from before the stream started is flushed.
    expect(src).toMatch(
      /markStreamingInactive[\s\S]{0,400}typingIntervals\.delete\(jid\)/,
    );
  });

  it('markStreamingActive also clears any in-flight bare-typing interval', async () => {
    const src = await fs.readFile(
      new URL('./teams.ts', import.meta.url),
      'utf-8',
    );
    // The defensive clear inside markStreamingActive prevents the race
    // where the dispatcher opens a stream while a previous turn's
    // keepalive interval is still firing.
    expect(src).toMatch(
      /markStreamingActive[\s\S]{0,400}typingIntervals\.delete\(jid\)/,
    );
  });

  it('onTurnError suppresses known-benign streaming wire rejects', async () => {
    const src = await fs.readFile(
      new URL('./teams.ts', import.meta.url),
      'utf-8',
    );
    // The four known-benign reject substrings:
    //   - bare typing rejected because conversation is in stream-mode
    //   - bare message rejected because conversation is in stream-mode
    //   - multiple informative bootstraps rejected
    //   - user paused / client disabled streaming mid-flight
    // Posting 'Sorry, something went wrong' for any of these confuses
    // users (it interleaves with real agent output that lands seconds
    // later).
    expect(src).toMatch(
      /Only start streaming and continue streaming types are allowed/,
    );
    expect(src).toMatch(/Only end streaming type is allowed/);
    expect(src).toMatch(/You can set only one informative message/);
    expect(src).toMatch(/ContentStreamNotAllowed/);
    // And the catch-all error handler must early-return (no
    // sendActivity('Sorry...')) for the benign cases.
    expect(src).toMatch(/isBenignStreamingWireReject[\s\S]{0,500}return;\s*\}/);
  });

  // ---------- Behaviour: keepalive gate via class instance ----------
  //
  // We instantiate just the methods we care about by Object.create-ing
  // a stub with the same shape as TeamsChannel for the gate logic.
  // This avoids the heavy adapter+server+DI dance while still exercising
  // the actual setTyping function path.

  let timeouts: NodeJS.Timeout[] = [];
  beforeEach(() => {
    timeouts = [];
  });
  afterEach(() => {
    for (const t of timeouts) clearInterval(t);
    timeouts = [];
    vi.useRealTimers();
  });

  function makeStubChannel() {
    const sendActivityMock = vi.fn<
      (activity: Partial<Activity>) => Promise<void>
    >(async () => {});
    const continueConversationMock = vi.fn(
      async (_ref: unknown, fn: (ctx: any) => Promise<void>) => {
        await fn({ sendActivity: sendActivityMock });
      },
    );
    // Mirror TeamsChannel state shape closely enough that the real
    // setTyping, dynamically copied from the prototype, runs against it.
    const stub: any = {
      typingIntervals: new Map<string, NodeJS.Timeout>(),
      conversationRefs: new Map<string, unknown>([
        ['jid-A', { conversation: { id: 'A' } }],
      ]),
      streamingActiveJids: new Set<string>(),
      adapter: { continueConversation: continueConversationMock },
    };
    return { stub, sendActivityMock, continueConversationMock };
  }

  async function loadSetTyping() {
    const mod = await import('./teams.js');
    const fn = (mod.TeamsChannel.prototype as any).setTyping;
    expect(typeof fn).toBe('function');
    return fn;
  }

  it('setTyping(true) sends a bare typing when no stream is active', async () => {
    const { stub, sendActivityMock } = makeStubChannel();
    const setTyping = await loadSetTyping();
    await setTyping.call(stub, 'jid-A', true);
    // Track the interval so afterEach clears it.
    const interval = stub.typingIntervals.get('jid-A');
    if (interval) timeouts.push(interval);
    expect(sendActivityMock).toHaveBeenCalledTimes(1);
    expect(sendActivityMock.mock.calls[0][0]).toEqual({ type: 'typing' });
  });

  it('setTyping(true) does NOT send any activity when jid is in streamingActiveJids', async () => {
    const { stub, sendActivityMock } = makeStubChannel();
    stub.streamingActiveJids.add('jid-A');
    const setTyping = await loadSetTyping();
    await setTyping.call(stub, 'jid-A', true);
    expect(sendActivityMock).not.toHaveBeenCalled();
    // No interval should have been registered either.
    expect(stub.typingIntervals.has('jid-A')).toBe(false);
  });

  it('setTyping(true) tears down a stale interval BEFORE checking the stream gate', async () => {
    const { stub, sendActivityMock } = makeStubChannel();
    // Pretend a previous (non-stream) turn left an interval running.
    const stale = setInterval(() => {}, 100_000);
    timeouts.push(stale);
    stub.typingIntervals.set('jid-A', stale);
    // Now this jid enters stream mode.
    stub.streamingActiveJids.add('jid-A');
    const setTyping = await loadSetTyping();
    await setTyping.call(stub, 'jid-A', true);
    // The stale interval must have been removed from the map even
    // though the stream gate then suppresses the new one. Otherwise a
    // subsequent setTyping(false) would not be able to find it (the
    // interval object itself is still alive but unreferenced).
    expect(stub.typingIntervals.has('jid-A')).toBe(false);
    expect(sendActivityMock).not.toHaveBeenCalled();
  });

  it('setTyping(false) clears interval regardless of stream-active flag', async () => {
    const { stub, sendActivityMock } = makeStubChannel();
    // Set up a real keepalive first.
    const setTyping = await loadSetTyping();
    await setTyping.call(stub, 'jid-A', true);
    expect(stub.typingIntervals.has('jid-A')).toBe(true);
    const interval = stub.typingIntervals.get('jid-A');
    if (interval) timeouts.push(interval);
    expect(sendActivityMock).toHaveBeenCalledTimes(1);
    // Now go into stream mode and turn off keepalive.
    stub.streamingActiveJids.add('jid-A');
    await setTyping.call(stub, 'jid-A', false);
    expect(stub.typingIntervals.has('jid-A')).toBe(false);
  });

  // ---------- markStreamingActive / markStreamingInactive ----------

  it('markStreamingActive adds jid AND tears down any in-flight interval', async () => {
    const { stub, sendActivityMock } = makeStubChannel();
    const setTyping = await loadSetTyping();
    // Start a keepalive (jid not yet in stream-mode).
    await setTyping.call(stub, 'jid-A', true);
    expect(stub.typingIntervals.has('jid-A')).toBe(true);
    expect(sendActivityMock).toHaveBeenCalledTimes(1);
    const interval = stub.typingIntervals.get('jid-A');
    if (interval) timeouts.push(interval);
    // Now the dispatcher opens a stream.
    const mod = await import('./teams.js');
    const markActive = (mod.TeamsChannel.prototype as any).markStreamingActive;
    markActive.call(stub, 'jid-A');
    expect(stub.streamingActiveJids.has('jid-A')).toBe(true);
    expect(stub.typingIntervals.has('jid-A')).toBe(false);
  });

  it('markStreamingInactive clears jid AND any keepalive interval', async () => {
    const { stub } = makeStubChannel();
    stub.streamingActiveJids.add('jid-A');
    // Simulate an interval that somehow leaked back in.
    const leaked = setInterval(() => {}, 100_000);
    timeouts.push(leaked);
    stub.typingIntervals.set('jid-A', leaked);
    const mod = await import('./teams.js');
    const markInactive = (mod.TeamsChannel.prototype as any)
      .markStreamingInactive;
    markInactive.call(stub, 'jid-A');
    expect(stub.streamingActiveJids.has('jid-A')).toBe(false);
    expect(stub.typingIntervals.has('jid-A')).toBe(false);
  });

  it('markStreamingInactive is idempotent', async () => {
    const { stub } = makeStubChannel();
    const mod = await import('./teams.js');
    const markInactive = (mod.TeamsChannel.prototype as any)
      .markStreamingInactive;
    expect(() => markInactive.call(stub, 'jid-never-streamed')).not.toThrow();
    expect(stub.streamingActiveJids.has('jid-never-streamed')).toBe(false);
    expect(stub.typingIntervals.has('jid-never-streamed')).toBe(false);
  });
});
