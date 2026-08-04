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
 *      `streamInfo` entity with `streamType:'informative'` (the
 *      "start streaming" bootstrap). The Teams server returns the
 *      `streamId` on this response. Sending `streaming` as the very
 *      first activity is rejected by the server with
 *      "Only start streaming and continue streaming types are allowed
 *       as a typing activity".
 *   2. Each subsequent in-flight chunk is a `typing` activity carrying
 *      a `streamInfo` entity with `streamType:'streaming'` and a
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

import { randomUUID } from 'node:crypto';
import type { TurnContext, ConversationReference } from 'botbuilder';
import { logger } from '../log-extensions.js';
import type { NativeThinkingStreamHandle } from '../types-extensions.js';

/**
 * Per-activity outbound send timeout (ms).
 *
 * The Bot Framework adapter's `continueConversation`/`sendActivity` has
 * no built-in timeout. If the outbound tunnel accepts a frame but never
 * ACKs it (a "black-hole" send: the promise neither resolves, rejects,
 * nor throws), a raw `await this.send(...)` hangs forever. That wedges
 * the whole per-JID turn: `_drainLoop` never resolves `_drain` →
 * `end()`'s `_waitForDrain()` never returns → the dispatcher's
 * `runForGroup` never reaches `activeCount--` → the chat's queue slot is
 * held until `ncl restart`. This was the root cause of "Teams stuck,
 * only a restart fixes it" (kenan repro, 2026-07-13; confirmed against
 * INFO logs: only the affected JID wedged while independent task slots
 * kept running).
 *
 * `_sendWithTimeout` races every send against this deadline so control
 * flow is always freed and we can degrade to a plain message. 8s sits
 * comfortably above Teams' normal ~1s round-trip while still recovering
 * quickly when the transport black-holes. Note: the underlying send
 * promise cannot be truly aborted (BFA does not honor an AbortSignal on
 * the HTTP call), so a black-holed send leaks one pending continuation —
 * acceptable, because our turn is unblocked and the slot is freed.
 */
const SEND_TIMEOUT_MS = 8000;

/**
 * Wall-clock upper bound (ms) on how long `end()` waits for the drain
 * loop to flush. With every send bounded by SEND_TIMEOUT_MS the drain
 * can no longer hang, but this independent guard ensures a future logic
 * change (e.g. a chunk that keeps re-arming `_pendingChunk`) can never
 * re-introduce the unbounded `while (this._drain) await this._drain`
 * wedge.
 */
const DRAIN_WAIT_TIMEOUT_MS = SEND_TIMEOUT_MS + 5000;

/**
 * Thrown by `_sendWithTimeout` when an outbound activity exceeds
 * SEND_TIMEOUT_MS. Callers treat it like a generic wire failure
 * (abort stream + degrade to plain message), but the distinct type
 * keeps logs and tests unambiguous about *why* the send was abandoned.
 */
export class SendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Teams activity send timed out after ${timeoutMs}ms`);
    this.name = 'SendTimeoutError';
  }
}

/**
 * Extract the server's rejection detail from a Bot Framework send error.
 *
 * B1 (kenan Teams repro 2026-08-03): the previous diagnostic read
 * `err.body` / `err.response.body`, both of which are `undefined` for the
 * errors BFA actually throws now — so the live log showed `body=undefined`
 * and the *why* of the 400 was lost. BFA `@botframework-connector` routes
 * through `@azure/core-rest-pipeline`, whose `RestError`
 * (`@typespec/ts-http-runtime`) carries:
 *   - `statusCode`  HTTP status (number)
 *   - `code`        Bot Connector error code, lifted from
 *                   `response.parsedBody.error.code` by
 *                   `@azure/core-client` deserializationPolicy
 *   - `message`     server reason text (e.g. "Only start streaming...")
 *   - `response.bodyAsText`     raw JSON body string
 *   - `response.parsedBody.error` structured `{ code, message }`
 * We surface all of them (bodyText clamped) so the next occurrence is
 * self-diagnosing and can disambiguate suspect B-i (local streamId) vs
 * B-ii (service-side change) without a live debug session.
 */
export function extractWireRejectDetail(err: any): {
  statusCode?: number | string;
  code?: string;
  reason?: string;
  bodyText?: string;
} {
  const resp = err?.response;
  const parsedErr = resp?.parsedBody?.error;
  const rawBody = resp?.bodyAsText ?? err?.body ?? resp?.body;
  let bodyText: string | undefined;
  if (typeof rawBody === 'string') {
    bodyText = rawBody;
  } else if (rawBody != null) {
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText = String(rawBody);
    }
  }
  // Keep logs bounded — the reason string is what matters, not a wall of body.
  if (bodyText && bodyText.length > 600) bodyText = bodyText.slice(0, 600) + '…';
  return {
    statusCode: err?.statusCode ?? err?.code ?? err?.status,
    code: parsedErr?.code ?? err?.code,
    reason: parsedErr?.message ?? err?.message,
    bodyText,
  };
}

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
  // 2026-08-04: `streamId` is SERVER-assigned, not client-minted.
  //
  // Per learn.microsoft.com/microsoftteams/platform/bots/streaming-ux the
  // start-streaming frame carries NO streamId; the Bot Connector answers
  // `201 {"id":"a-0000l"}` and that id must be echoed as `streamId` on
  // every subsequent frame ("streamId from the initial streaming request").
  //
  // The previous "Bug 1 fix" (2026-05-29) minted a local randomUUID() and
  // stamped it onto the bootstrap frame, then deliberately discarded the
  // server's response id. That inverted the protocol: we asserted an id the
  // service never issued. It went unnoticed because the sibling bug in this
  // same commit (entity `type: 'streaminfo'` instead of the spec's
  // `streamInfo`) meant the server never parsed the entity at all, so the
  // bogus id was invisible. Fixing the casing alone would have surfaced this
  // as the next 400, so both are corrected together.
  //
  // undefined until the bootstrap response arrives. If the service returns
  // no id we cannot legally continue the stream, so `_streamAbandoned`
  // flips and end() degrades to a single plain message.
  private _streamId: string | undefined;
  /**
   * Set when the bootstrap frame was accepted but carried no usable id.
   * Continuing without a server streamId is a protocol violation, so we
   * stop streaming and let `end()` publish one plain message instead.
   */
  private _streamAbandoned = false;
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
  /**
   * A2 (2026-08-03): true when `end()` tried to publish the final reply
   * and EVERY send path failed (streaming final rejected AND the plain
   * last-ditch fallback also rejected). The dispatcher reads this via
   * `endFailed()` after awaiting `end()` and, when true, must NOT mark the
   * turn delivered — it rolls the message cursor back so the turn retries
   * instead of the reply silently vanishing. Distinct from `_cancelled`
   * (wire gave up but a plain degrade may still have landed) and
   * `isCancelled()` (probe used mid-turn to arm the coalesce buffer).
   */
  private _deliveryFailed = false;
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
    // Teams throttles streaming to 1 request/second and the docs recommend
    // buffering tokens for 1.5-2s to keep the stream smooth
    // (learn.microsoft.com/.../bots/streaming-ux). The old 1000ms sat exactly
    // on the throttle limit, so any scheduling jitter pushed a frame over it
    // and risked a 429/ContentStreamSequenceOrderPreConditionFailed. Use
    // 1500ms to stay inside the recommended band.
    if (opts.delayInMs !== undefined) {
      this._delayInMs = opts.delayInMs;
    } else if (opts.channelId === 'msteams') {
      this._delayInMs = 1500;
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
    // streamInfo entities since they only make sense inside an active
    // stream.
    if (this._cancelled || !this._isStreamingChannel) {
      try {
        const id = await this._sendWithTimeout({ type: 'message', text: finalText });
        // B5 (2026-08-03): tag which terminal path delivered so an
        // error-only log tells us how the reply landed (or that it didn't).
        this.log.info(
          { endPath: 'cancelled-early-degrade', delivered: true, hasId: !!id },
          'Teams reply delivered via plain-degraded (wire cancelled before drain)',
        );
        return id;
      } catch (err: any) {
        this._deliveryFailed = true;
        this.log.warn(
          { endPath: 'cancelled-early-degrade', delivered: false, ...extractWireRejectDetail(err) },
          'Teams streaming: degraded final send failed (reply DROPPED)',
        );
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
        const id = await this._sendWithTimeout({ type: 'message', text: finalText });
        this.log.info(
          { endPath: 'cancelled-postdrain-degrade', delivered: true, hasId: !!id },
          'Teams reply delivered via plain-degraded (wire cancelled during drain)',
        );
        return id;
      } catch (err: any) {
        this._deliveryFailed = true;
        this.log.warn(
          { endPath: 'cancelled-postdrain-degrade', delivered: false, ...extractWireRejectDetail(err) },
          'Teams streaming: post-drain degraded final send failed (reply DROPPED)',
        );
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
        const id = await this._sendWithTimeout({ type: 'message', text: finalText });
        this.log.info(
          { endPath: 'no-streamId-degrade', delivered: true, hasId: !!id },
          'Teams reply delivered via plain-degraded (no streamId obtained)',
        );
        return id;
      } catch (err: any) {
        this._deliveryFailed = true;
        this.log.warn(
          { endPath: 'no-streamId-degrade', delivered: false, ...extractWireRejectDetail(err) },
          'Teams streaming: final without streamId, plain send failed (reply DROPPED)',
        );
        return;
      }
    }
    // NOTE: the final `message` activity MUST NOT carry `streamSequence`.
    // The Teams streaming spec is explicit: "For the final message,
    // streamSequence must not be set." and the reference JSON for the
    // end-streaming frame omits it entirely
    // (learn.microsoft.com/.../bots/streaming-ux "Final Streaming").
    // We previously stamped `streamSequence: this._nextSequence++` here,
    // which is a strong suspect for the server rejecting the final frame
    // with "Only end streaming type is allowed as a message activity"
    // (kenan Teams repro 2026-07-27: every turn logged that reject 200ms
    // after the typing-frame reject). Only `streamType: 'final'` +
    // `streamId` belong on the end frame.
    const activity: Partial<TeamsActivity> = {
      type: 'message',
      text: finalText,
      entities: [
        {
          type: 'streamInfo',
          streamType: 'final',
        },
      ],
    };
    this._stampStreamId(activity);
    try {
      const id = await this._sendWithTimeout(activity);
      this.log.info(
        { endPath: 'final-frame', delivered: true, hasId: !!id },
        'Teams reply delivered via streaming final frame',
      );
      return id;
    } catch (err: any) {
      this.log.warn(
        { endPath: 'final-frame', streamType: 'final', hasStreamId: !!this._streamId, ...extractWireRejectDetail(err) },
        'Teams streaming: final activity send failed; falling back to plain message',
      );
      // Last-ditch: send the final as a plain message so we don't
      // silently drop the agent's reply. Strip stream entities since
      // they only make sense inside an active stream.
      try {
        const id = await this._sendWithTimeout({ type: 'message', text: finalText });
        this.log.info(
          { endPath: 'final-frame-plain-fallback', delivered: true, hasId: !!id },
          'Teams reply delivered via plain fallback (final frame rejected)',
        );
        return id;
      } catch (err2: any) {
        // Both the streaming final AND the plain fallback failed: the
        // reply is genuinely lost. B5 tags this so an error-only export
        // makes the drop unambiguous; A2 flips `_deliveryFailed` so the
        // dispatcher turns this into a cursor rollback (retry) instead of
        // silently marking the turn delivered.
        this._deliveryFailed = true;
        this.log.error(
          { endPath: 'total-failure', delivered: false, ...extractWireRejectDetail(err2) },
          'Teams streaming: fallback final send also failed (reply DROPPED)',
        );
      }
    }
  }

  /**
   * Wait for the background drain started by chunk() to reveal its terminal
   * wire state. chunk() deliberately returns before Bot Connector ACKs so it
   * cannot serialize the agent on Teams' pacing; callers therefore need this
   * bounded terminal barrier before deciding that the stream is healthy.
   */
  async settle(): Promise<void> {
    await this._waitForDrain();
  }

  async cancel(): Promise<void> {
    if (this._ended) return;

    // A chunk send runs in the background. If its 400/timeout arrives after
    // the dispatcher's immediate probe but before terminal cleanup, marking
    // this as an explicit cancel would hide the real wire failure from
    // isCancelled() and suppress the plain fallback. Settle first (bounded by
    // _waitForDrain), then preserve wire-cancel state when the drain failed.
    await this.settle();
    if (this._cancelled || !this._isStreamingChannel) return;

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

  /**
   * A2 (2026-08-03): true only after `end()` has run AND every publish
   * attempt for the final reply failed (streaming final + plain last-ditch
   * both rejected). The dispatcher awaits `end()` then checks this to
   * decide whether the turn actually delivered: on failure it must not
   * mark the turn finalized and should roll the message cursor back so the
   * turn retries, instead of the reply silently vanishing. Returns false
   * on the happy path, on explicit cancel, and any time a degrade landed.
   */
  endFailed(): boolean {
    return this._deliveryFailed;
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
            type: 'streamInfo',
            streamType: isBootstrap ? 'informative' : 'streaming',
            streamSequence: this._nextSequence++,
          },
        ],
      };
      this._stampStreamId(activity);
      try {
        const id = await this._sendWithTimeout(activity);
        // The bootstrap (start-streaming) call is the ONLY one that yields a
        // streamId: the Bot Connector answers 201 {"id":"a-0000l"} and every
        // later frame must echo it back. Capture it here.
        //
        // If the service accepted the bootstrap but returned no id we cannot
        // legally send continuation frames (they would omit the required
        // streamId). Rather than fabricate one — the 2026-05-29 mistake —
        // abandon the stream so end() degrades to a single plain message.
        if (isBootstrap) {
          if (typeof id === 'string' && id.length > 0) {
            this._streamId = id;
          } else {
            this.log.info('Teams streaming: bootstrap returned no streamId; degrading to a single plain message');
            this._streamAbandoned = true;
            this._cancelled = true;
            this._bootstrapSent = true;
            this._lastSent = textToSend;
            return;
          }
        }
        this._bootstrapSent = true;
        this._lastSent = textToSend;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        // Diagnostic (kenan Teams repro 2026-07-27, body fix 2026-08-03 B1):
        // capture the server's rejection detail so we can tell WHY a frame
        // was refused (bootstrap informative vs continue streaming; error
        // code/subcode + raw body from the Bot Connector). See
        // `extractWireRejectDetail` for where BFA now stashes these.
        const wireDiag = {
          isBootstrap: !this._bootstrapSent,
          streamType: this._bootstrapSent ? 'streaming' : 'informative',
          sequence: this._nextSequence - 1,
          ...extractWireRejectDetail(err),
        };
        if (err instanceof SendTimeoutError) {
          // Black-holed transport: the frame was accepted (or the socket
          // stalled) but never ACKed. Abort the stream so `end()` can
          // degrade to a single plain `message` instead of hanging the
          // whole per-JID turn forever (root cause of "Teams stuck until
          // restart", 2026-07-13).
          this.log.warn(
            { err: msg, sequence: this._nextSequence - 1 },
            'Teams streaming: chunk send timed out; aborting stream and degrading to plain message',
          );
          this._cancelled = true;
          return;
        }
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
        // Other errors (incl. the wire-protocol rejects
        // "Only start streaming and continue streaming types are
        // allowed..."): log with full diagnostic and stop the stream.
        // end() will degrade to a plain-message fallback so the reply
        // still lands.
        this.log.warn(
          { err: msg, ...wireDiag },
          'Teams streaming: chunk send failed; aborting stream (end() will degrade to plain message)',
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
    // Independent upper bound. With every `send()` bounded by
    // SEND_TIMEOUT_MS the drain can no longer hang on the wire, but this
    // guard ensures a future change that keeps re-arming `_pendingChunk`
    // (or any other logic regression) can never re-introduce the
    // original unbounded `while (this._drain) await this._drain` wedge
    // that held the per-JID queue slot until `ncl restart`.
    const deadline = Date.now() + DRAIN_WAIT_TIMEOUT_MS;
    while (this._drain) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log.warn(
          { timeoutMs: DRAIN_WAIT_TIMEOUT_MS },
          'Teams streaming: drain wait exceeded upper bound; proceeding to final send',
        );
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      });
      try {
        await Promise.race([this._drain, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  /**
   * Stamp the stream id onto an outgoing activity once we have one.
   * The protocol requires `id` AND the first entity's `streamId` to
   * carry it.
   */
  private _stampStreamId(activity: Partial<TeamsActivity>): void {
    // No-op until the bootstrap response supplies an id: the start-streaming
    // frame must NOT carry a streamId (the id is *returned* by that call).
    // Every later frame must carry it.
    if (!this._streamId) return;
    activity.id = this._streamId;
    if (!activity.entities) activity.entities = [];
    if (!activity.entities[0]) activity.entities[0] = { type: 'streamInfo' };
    activity.entities[0].streamId = this._streamId;
  }

  /**
   * Send one activity with a wall-clock timeout so a black-holed
   * transport (accepts the frame, never ACKs, never throws) can no
   * longer hang the turn forever. On timeout we throw a
   * `SendTimeoutError` that callers treat like any other wire failure:
   * abort the stream and degrade to a single plain `message`.
   *
   * The losing (timed-out) send promise is intentionally left pending
   * — the BFA HTTP call has no abort hook — but control flow returns
   * immediately, which is the whole point (frees `_drain` and the queue
   * slot).
   */
  private async _sendWithTimeout(activity: Partial<TeamsActivity>): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SendTimeoutError(SEND_TIMEOUT_MS)), SEND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.send(activity), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    // Delivery-guarantee fix (kenan Teams repro 2026-07-27): capture any
    // error from `sendActivity` inside the logic callback and re-surface
    // it to the caller (the streaming session).
    //
    // Why this is necessary: `continueConversation` runs our logic through
    // the adapter's `runMiddleware`, which routes any thrown error to
    // `adapter.onTurnError` (see botbuilder-core/botAdapter.js). The Teams
    // adapter's `onTurnError` classifies streaming-wire rejects
    // ("Only start streaming and continue streaming types are allowed...",
    // "Only end streaming type is allowed...") as benign and returns
    // WITHOUT re-throwing — so `continueConversation` resolves as if the
    // send succeeded. The streaming session then never sees the failure,
    // `_cancelled` stays false, and `end()`'s degrade-to-plain-message
    // path (and the dispatcher's coalesced-final fallback) never fire →
    // the agent's final answer is silently dropped and the user sees
    // "typing" then nothing.
    //
    // By catching the error here and NOT re-throwing inside the callback,
    // `onTurnError` is not invoked for outbound streaming sends (so it no
    // longer swallows the signal, and it does not inject a spurious
    // "Sorry, something went wrong." proactive message). We then re-throw
    // after `continueConversation` resolves, which the streaming session's
    // `_sendWithTimeout` treats like any other wire failure: abort the
    // stream and degrade to a single plain `message`. onTurnError remains
    // the catch-all for the INBOUND turn path, which is unaffected.
    let sendError: unknown;
    await opts.adapter.continueConversation(opts.ref, async (ctx) => {
      try {
        const res = await ctx.sendActivity(activity as any);
        id = res?.id;
      } catch (err) {
        sendError = err;
      }
    });
    if (sendError !== undefined) throw sendError;
    return id;
  };
}
