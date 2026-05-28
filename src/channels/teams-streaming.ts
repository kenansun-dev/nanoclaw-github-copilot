/**
 * Teams native streaming session.
 *
 * Implements the wire protocol documented at
 *   https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
 * and used by Microsoft's own `@microsoft/agents-hosting` package
 * (`packages/agents-hosting/src/app/streaming/streamingResponse.ts`).
 *
 * Why we re-implement instead of pulling that package in:
 *  - We're on `botbuilder@4.x` (Bot Framework SDK), not the newer
 *    `@microsoft/agents-hosting@1.x` (Microsoft 365 Agents SDK).
 *  - The wire protocol is small (~150 lines) and TurnContext-compatible
 *    across both SDKs. Pulling the new SDK would drag a parallel
 *    adapter stack into a fork that has carefully customized BFA.
 *  - We want a stable surface to test against without instantiating
 *    the full Teams adapter.
 *
 * Wire protocol summary:
 *   1. The FIRST activity is a `typing` activity carrying a
 *      `streaminfo` entity with `streamType:'informative'` (the
 *      "start streaming" bootstrap). The Teams server returns the
 *      `streamId` on this response. Sending `streaming` as the very
 *      first activity is rejected by the server with
 *      "Only start streaming and continue streaming types are allowed
 *       as a typing activity".
 *   2. Each subsequent in-flight chunk is a `typing` activity carrying
 *      a `streaminfo` entity with `streamType:'streaming'` and a
 *      monotonically increasing `streamSequence`. These activities set
 *      `id = streamId` and include `streamId` on the first entity.
 *      Teams uses this to render all updates in a single bubble
 *      (no message duplication).
 *   3. The terminal activity is a `message` activity with
 *      `streamType:'final'`. It MUST also carry `streamId` (otherwise
 *      Teams rejects with "Only end streaming type is allowed as a
 *      message activity"). If we never obtained a `streamId`, `end()`
 *      degrades to a plain non-streaming `message` activity so the
 *      agent's reply still lands.
 *   4. Activities MUST be sent serially. We enforce this with a
 *      single in-flight flag (`_chunkQueued`) + a queue + a serial
 *      `drainQueue` walker. Out-of-order updates would be dropped
 *      by the Teams server (sequence-based ordering).
 *   5. Teams enforces a chunk delay (default 1000ms). We honor it
 *      with `setTimeout` between drains.
 *   6. Errors:
 *      - `ContentStreamNotAllowed` → user paused/cancelled at client;
 *        mark as cancelled and stop sending further activities.
 *      - "streaming api is not enabled" → channel is not
 *        streaming-capable for this conversation; flip
 *        `_isStreamingChannel = false` so subsequent chunks accumulate
 *        text only and `end()` posts a single non-streaming message.
 *      - Other failures cancel the stream and let the dispatcher
 *        decide via the returned error path.
 *
 * Race-condition handling (the four gates that the previous
 * `editMessage` path lacked):
 *   - Single in-flight: `_chunkQueued` + `_queueSync` ensure only
 *     one outbound activity at a time per session.
 *   - Sequence ordering: `_nextSequence` provides server-side
 *     deduplication / ordering invariants.
 *   - Stream binding: every activity carries the same `streamId` so
 *     the Teams client knows they belong to one bubble.
 *   - Pacing: per-chunk delay matches Teams' enforced rate limit.
 */

import type { TurnContext, ConversationReference } from 'botbuilder';
import { logger } from '../log-extensions.js';
import type { NativeThinkingStreamHandle } from '../types-extensions.js';

// --- Types: minimal, deliberately narrow to ease unit testing ----------

/**
 * Sender abstraction. Production wires this to
 * `adapter.continueConversation(ref, ctx => ctx.sendActivity(activity))`.
 * Tests pass a spy.
 *
 * Returns the activity id assigned by the server (or undefined when
 * not available — the dispatcher tolerates this).
 */
export type ActivitySender = (activity: Partial<TeamsActivity>) => Promise<string | undefined>;

/**
 * Subset of Bot Framework `Activity` shape we emit. Kept loose so we
 * don't have to import the full schema in tests.
 */
export interface TeamsActivity {
  type: 'typing' | 'message';
  text?: string;
  id?: string;
  entities?: Array<{
    type: string;
    streamType?: 'informative' | 'streaming' | 'final';
    streamSequence?: number;
    streamId?: string;
  }>;
}

export interface TeamsStreamingOpts {
  /** Channel id ("msteams" in production). Used to set chunk delay. */
  channelId?: string;
  /** Override the inter-chunk delay (ms). Tests should pass 0. */
  delayInMs?: number;
  /** Logger override (tests). */
  log?: typeof logger;
}

/**
 * Implements `StreamHandle` on top of an `ActivitySender`.
 *
 * Lifecycle: open → chunk(text) × N → end(text) | cancel().
 * `end` and `cancel` are idempotent.
 */
export class TeamsStreamingSession implements NativeThinkingStreamHandle {
  private _streamId: string | undefined;
  /**
   * True once the bootstrap (`streamType: 'informative'`) activity has
   * been sent. Tracked separately from `_streamId` because the server
   * response may not always carry an id back — if we relied on
   * `!_streamId` to mean "first activity" we'd send `informative`
   * forever, and Teams rejects more than one informative per stream
   * ("You can set only one informative message").
   */
  private _bootstrapSent = false;
  /**
   * Phase machine for native thinking support (PR #53 phase B).
   *
   *   thinking  -- appendThinking() updates _latestText; chunk() also allowed
   *     |          (dispatcher may call chunk() with the cumulative thinking
   *     |           snapshot in `reasoning=on` mode; we don't distinguish).
   *     | commitAnswer()   sync flip; resets _latestText/_lastSent so the
   *     v                  next outbound `streaming` chunk overwrites the
   *   answer    -- chunk() updates _latestText; appendThinking() is dropped
   *     |          (case `l` in the proposal: trailing reasoning_delta after
   *     |           the first answer chunk must NOT regress the bubble).
   *     | end() | cancel()
   *     v
   *   ended     -- everything is a no-op.
   *
   * The phase machine is irreversible. `commitAnswer()` from `answer` /
   * `ended` is a no-op; `appendThinking()` from `answer` / `ended` drops
   * the call with a debug log.
   *
   * Channels that don't set `Channel.supportsNativeThinking` simply never
   * call appendThinking/commitAnswer, so the phase stays `thinking` for
   * the whole session and behavior is identical to pre-PR #53.
   */
  private _phase: 'thinking' | 'answer' | 'ended' = 'thinking';
  private _nextSequence = 1;
  private _ended = false;
  private _cancelled = false;
  /**
   * True when the stream stopped because the dispatcher explicitly called
   * `cancel()` (turn boundary, finally-guard, etc.). In that case `end()`
   * must publish nothing — the dispatcher has decided this stream is dead.
   *
   * Distinct from `_cancelled`, which is also set when the wire layer
   * rejects mid-stream (`ContentStreamNotAllowed`, generic send failure):
   * those cases stop further streaming activities, but `end()` MUST still
   * publish the final text as a plain non-streaming message, otherwise
   * the agent's reply silently disappears.
   *
   * Bug discovered in code review (rpi5, 2026-04-22): without this flag,
   * `ContentStreamNotAllowed` mid-stream caused `_cancelled = true`, then
   * `end()` saw `_cancelled` and bailed, losing the final reply. The
   * pre-existing comment in `_drainLoop` already promised this would
   * "allow `end()` to publish a final non-streaming message" — we just
   * never wired the distinction.
   */
  private _explicitCancel = false;
  /** Cumulative text last sent to client; used to skip no-op chunks. */
  private _lastSent = '';
  /** Cumulative text most recently received; what `end` will publish. */
  private _latestText = '';
  private _delayInMs: number;
  /** When true, the channel told us streaming is not allowed; degrade. */
  private _isStreamingChannel = true;
  /** Single-flight gate. */
  private _drain: Promise<void> | undefined;
  private _pendingChunk = false;
  private readonly log: typeof logger;

  constructor(
    private readonly send: ActivitySender,
    opts: TeamsStreamingOpts = {},
  ) {
    this.log = opts.log ?? logger;
    // Teams enforces ~1s; other Bot Framework channels default lower.
    if (opts.delayInMs !== undefined) {
      this._delayInMs = opts.delayInMs;
    } else if (opts.channelId === 'msteams') {
      this._delayInMs = 1000;
    } else {
      this._delayInMs = 250;
    }
  }

  // --- Public StreamHandle API ----------------------------------------

  async chunk(cumulativeText: string): Promise<void> {
    if (this._ended || this._cancelled) return;
    this._latestText = cumulativeText;
    if (!this._isStreamingChannel) {
      // Channel rejected streaming earlier — accumulate, publish on end().
      return;
    }
    this._scheduleChunk();
    // We deliberately do NOT await the drain here. The dispatcher feeds
    // chunks at agent-output cadence (often << 1s); awaiting would
    // serialize the agent on Teams' 1s pacing and starve the partial
    // pipeline. Drain runs in the background; `end()` awaits it.
    return;
  }

  // --- Native thinking phase API (PR #53 phase B) ---------------------

  /**
   * Update the in-flight thinking-text snapshot. Behaves like `chunk()`
   * during the `thinking` phase; drops the call (with a debug log) once
   * the dispatcher has committed to the answer phase. This is the
   * critical guard for case (l) in the proposal: SDK trailing
   * `reasoning_delta` events after the first answer chunk must NOT
   * regress the streaming bubble back to thinking text.
   */
  async appendThinking(cumulativeText: string): Promise<void> {
    if (this._phase !== 'thinking') {
      this.log.debug(
        { phase: this._phase, len: cumulativeText.length },
        'Teams streaming: appendThinking dropped (phase != thinking)',
      );
      return;
    }
    return this.chunk(cumulativeText);
  }

  /**
   * Flip the session from thinking-phase to answer-phase. Resets
   * `_latestText` / `_lastSent` so the next outbound `streaming` chunk
   * truly overwrites the previously streamed thinking text in the same
   * client-side bubble (the `commitAnswer reset _latestText` mechanism
   * documented in the proposal).
   *
   * Idempotent — calling outside the thinking phase is a no-op, so the
   * dispatcher can safely call it on every answer partial without
   * worrying about double-flips.
   *
   * NOTE: deliberately does NOT enqueue a chunk on its own. The very
   * next `chunk(answerText)` from the dispatcher is what actually
   * reaches the wire (with empty `_lastSent` it bypasses the no-op
   * skip in `_drainLoop`). If the dispatcher wanted to publish a tiny
   * "resetting\u2026" placeholder it could, but we leave that policy to
   * the caller.
   */
  commitAnswer(): void {
    if (this._phase !== 'thinking') return;
    this._phase = 'answer';
    this._latestText = '';
    this._lastSent = '';
    // We intentionally keep `_bootstrapSent` true: the informative frame
    // already went out, and Teams accepts only ONE informative per stream.
    // Subsequent answer chunks must continue as `streaming` activities
    // under the same streamId.
  }

  async end(finalText: string): Promise<string | void> {
    if (this._ended) return;
    this._ended = true;
    this._phase = 'ended';
    this._latestText = finalText;
    // Explicit dispatcher-driven cancel: nothing to publish.
    if (this._explicitCancel) return;

    // Wire-level cancel (ContentStreamNotAllowed / generic send failure)
    // OR channel-rejected streaming: degrade to a single non-streaming
    // `message` activity so the agent's final reply still lands. We strip
    // streaminfo entities since they only make sense inside an active
    // stream.
    if (this._cancelled || !this._isStreamingChannel) {
      try {
        const id = await this.send({ type: 'message', text: finalText });
        return id;
      } catch (err: any) {
        this.log.warn({ err: err?.message ?? String(err) }, 'Teams streaming: degraded final send failed');
        return;
      }
    }

    // Wait for any pending streaming chunks to flush so the final
    // arrives in-order with respect to typing activities. The drain
    // could have flipped `_cancelled` (e.g. ContentStreamNotAllowed
    // mid-flush) — if so, fall through to the degraded plain-message
    // path instead of bailing silently.
    await this._waitForDrain();
    if (this._explicitCancel) return;
    if (this._cancelled || !this._isStreamingChannel) {
      try {
        const id = await this.send({ type: 'message', text: finalText });
        return id;
      } catch (err: any) {
        this.log.warn({ err: err?.message ?? String(err) }, 'Teams streaming: post-drain degraded final send failed');
        return;
      }
    }

    // The final `message` activity MUST carry the `streamId` returned
    // by the first typing activity, otherwise Teams rejects it with:
    //   "Only end streaming type is allowed as a message activity"
    // (the validator is checking the entity shape against the
    // end-streaming contract, which requires streamId). If we never got
    // a streamId — e.g. the channel returned no id, or no chunks fired —
    // fall back to a plain non-streaming message so the agent's reply
    // still lands. Regression discovered 2026-04-22.
    if (!this._streamId) {
      try {
        const id = await this.send({ type: 'message', text: finalText });
        return id;
      } catch (err: any) {
        this.log.warn(
          { err: err?.message ?? String(err) },
          'Teams streaming: final without streamId, plain send failed',
        );
        return;
      }
    }
    const activity: Partial<TeamsActivity> = {
      type: 'message',
      text: finalText,
      entities: [
        {
          type: 'streaminfo',
          streamType: 'final',
          streamSequence: this._nextSequence++,
        },
      ],
    };
    this._stampStreamId(activity);
    try {
      const id = await this.send(activity);
      return id;
    } catch (err: any) {
      this.log.warn(
        { err: err?.message ?? String(err) },
        'Teams streaming: final activity send failed; falling back to plain message',
      );
      // Last-ditch: send the final as a plain message so we don't
      // silently drop the agent's reply. Strip stream entities since
      // they only make sense inside an active stream.
      try {
        const id = await this.send({ type: 'message', text: finalText });
        return id;
      } catch (err2: any) {
        this.log.error({ err: err2?.message ?? String(err2) }, 'Teams streaming: fallback final send also failed');
      }
    }
  }

  async cancel(): Promise<void> {
    if (this._cancelled || this._ended) return;
    this._explicitCancel = true;
    this._cancelled = true;
    this._ended = true;
    this._phase = 'ended';
    // Drop any queued work; let in-flight drain finish on its own.
    this._pendingChunk = false;
    // Best-effort: don't await drain on cancel — the dispatcher uses
    // cancel for fast turn-boundary cleanup.
  }

  /**
   * Whether the wire transport has given up (wire reject, generic
   * send failure). Distinct from explicit dispatcher `cancel()`:
   * an explicit cancel means "do not publish anything" while a wire
   * cancel means "stop streaming but `end()` will still publish a
   * plain final message". Dispatcher reads this to switch the
   * remaining turn to coalesced-final mode (bug 2 fallback). See
   * `docs/proposals/2026-05-29-teams-streaming-multi-final-fix.md`.
   */
  isCancelled(): boolean {
    return this._cancelled && !this._explicitCancel;
  }

  // --- Internals ------------------------------------------------------

  /**
   * Enqueue a chunk send. If a drain is already running it'll pick up
   * the latest cumulative text on its next iteration (we always send
   * `_latestText`, never a captured snapshot).
   */
  private _scheduleChunk(): void {
    this._pendingChunk = true;
    if (!this._drain) {
      this._drain = this._drainLoop().finally(() => {
        this._drain = undefined;
      });
    }
  }

  private async _drainLoop(): Promise<void> {
    while (this._pendingChunk && !this._cancelled && !this._ended) {
      this._pendingChunk = false;
      const textToSend = this._latestText;
      if (textToSend === this._lastSent) {
        // Nothing new since last send; skip pacing wait too.
        continue;
      }
      // Teams server requires the FIRST activity in a stream to be a
      // start-streaming signal (`streamType: 'informative'`). Subsequent
      // typing activities use `streaming` and MUST carry the `streamId`
      // returned by the first send. Sending `streaming` as the very first
      // activity is rejected with:
      //   "Only start streaming and continue streaming types are allowed
      //    as a typing activity"
      // (per-doc literal enum is `informative` / `streaming`; the server
      // error wording reads them as 'start' / 'continue'). The MS
      // reference impl (@microsoft/agents-hosting StreamingResponse)
      // exposes `queueInformativeUpdate()` for this; bots that skip it
      // and call `queueTextChunk()` first hit the same regression.
      // Regression discovered 2026-04-22 (kenan repro on Teams Windows
      // client). Fix: bootstrap the stream with one informative activity
      // before any `streaming` chunks.
      //
      // Why we use `_bootstrapSent` instead of `!_streamId`: the server
      // response is not guaranteed to carry an `id` back. If we keyed
      // off `!_streamId` and the response came back without an id,
      // every subsequent chunk would also be sent as `informative` —
      // and Teams rejects more than one informative per stream
      // ("You can set only one informative message"). Tracking the
      // bootstrap step separately avoids that failure mode.
      const isBootstrap = !this._bootstrapSent;
      const activity: Partial<TeamsActivity> = {
        type: 'typing',
        text: textToSend,
        entities: [
          {
            type: 'streaminfo',
            streamType: isBootstrap ? 'informative' : 'streaming',
            streamSequence: this._nextSequence++,
          },
        ],
      };
      this._stampStreamId(activity);
      try {
        const id = await this.send(activity);
        if (!this._streamId && id) this._streamId = id;
        this._bootstrapSent = true;
        this._lastSent = textToSend;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes('ContentStreamNotAllowed')) {
          // User paused / client disabled streaming. Stop sending,
          // but allow `end()` to publish a final non-streaming message
          // so the agent's reply still lands.
          this.log.info('Teams streaming: client returned ContentStreamNotAllowed; degrading');
          this._cancelled = true;
          return;
        }
        if (msg.includes('BadArgument') && msg.toLowerCase().includes('streaming api is not enabled')) {
          this.log.info('Teams streaming: channel rejected streaming; falling back to single final message');
          this._isStreamingChannel = false;
          // Don't cancel — `end()` will send a non-streaming final.
          return;
        }
        // Other errors: log and stop the stream. End() will try a
        // plain-message fallback.
        this.log.warn(
          { err: msg, sequence: this._nextSequence - 1 },
          'Teams streaming: chunk send failed; aborting stream',
        );
        this._cancelled = true;
        return;
      }
      if (this._delayInMs > 0 && this._pendingChunk) {
        await new Promise((r) => setTimeout(r, this._delayInMs));
      }
    }
  }

  private async _waitForDrain(): Promise<void> {
    while (this._drain) {
      await this._drain;
    }
  }

  /**
   * Stamp the stream id onto an outgoing activity once we have one.
   * The protocol requires `id` AND the first entity's `streamId` to
   * carry it.
   */
  private _stampStreamId(activity: Partial<TeamsActivity>): void {
    if (!this._streamId) return;
    activity.id = this._streamId;
    if (!activity.entities) activity.entities = [];
    if (!activity.entities[0]) activity.entities[0] = { type: 'streaminfo' };
    activity.entities[0].streamId = this._streamId;
  }
}

/**
 * Helper to construct an `ActivitySender` that wraps a Bot Framework
 * adapter's `continueConversation`. Pulled out so the streaming class
 * stays free of adapter coupling.
 */
export function makeAdapterSender(opts: {
  adapter: {
    continueConversation: (ref: ConversationReference, logic: (ctx: TurnContext) => Promise<void>) => Promise<void>;
  };
  ref: ConversationReference;
}): ActivitySender {
  return async (activity: Partial<TeamsActivity>) => {
    let id: string | undefined;
    await opts.adapter.continueConversation(opts.ref, async (ctx) => {
      const res = await ctx.sendActivity(activity as any);
      id = res?.id;
    });
    return id;
  };
}
