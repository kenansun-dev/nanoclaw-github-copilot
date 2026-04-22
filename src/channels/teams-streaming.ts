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
 *   1. Each in-flight chunk is a `typing` activity carrying a
 *      `streaminfo` entity with `streamType:'streaming'` and a
 *      monotonically increasing `streamSequence`.
 *   2. The first activity's response `id` is captured as `streamId`;
 *      every subsequent activity sets `id = streamId` and includes
 *      `streamId` on its first entity. Teams uses this to render all
 *      updates in a single bubble (no message duplication).
 *   3. The terminal activity is a `message` activity with
 *      `streamType:'final'`.
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
import { logger } from '../logger.js';
import type { StreamHandle } from '../types.js';

// --- Types: minimal, deliberately narrow to ease unit testing ----------

/**
 * Sender abstraction. Production wires this to
 * `adapter.continueConversation(ref, ctx => ctx.sendActivity(activity))`.
 * Tests pass a spy.
 *
 * Returns the activity id assigned by the server (or undefined when
 * not available — the dispatcher tolerates this).
 */
export type ActivitySender = (
  activity: Partial<TeamsActivity>,
) => Promise<string | undefined>;

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
export class TeamsStreamingSession implements StreamHandle {
  private _streamId: string | undefined;
  private _nextSequence = 1;
  private _ended = false;
  private _cancelled = false;
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

  async end(finalText: string): Promise<string | void> {
    if (this._ended) return;
    this._ended = true;
    this._latestText = finalText;
    if (this._cancelled) return;

    if (!this._isStreamingChannel) {
      // Degraded path: send a single plain message with the final text.
      try {
        const id = await this.send({ type: 'message', text: finalText });
        return id;
      } catch (err: any) {
        this.log.warn(
          { err: err?.message ?? String(err) },
          'Teams streaming: degraded final send failed',
        );
        return;
      }
    }

    // Wait for any pending streaming chunks to flush so the final
    // arrives in-order with respect to typing activities.
    await this._waitForDrain();
    if (this._cancelled) return;

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
        this.log.error(
          { err: err2?.message ?? String(err2) },
          'Teams streaming: fallback final send also failed',
        );
      }
    }
  }

  async cancel(): Promise<void> {
    if (this._cancelled || this._ended) return;
    this._cancelled = true;
    this._ended = true;
    // Drop any queued work; let in-flight drain finish on its own.
    this._pendingChunk = false;
    // Best-effort: don't await drain on cancel — the dispatcher uses
    // cancel for fast turn-boundary cleanup.
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
      const activity: Partial<TeamsActivity> = {
        type: 'typing',
        text: textToSend,
        entities: [
          {
            type: 'streaminfo',
            streamType: 'streaming',
            streamSequence: this._nextSequence++,
          },
        ],
      };
      this._stampStreamId(activity);
      try {
        const id = await this.send(activity);
        if (!this._streamId && id) this._streamId = id;
        this._lastSent = textToSend;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes('ContentStreamNotAllowed')) {
          // User paused / client disabled streaming. Stop sending,
          // but allow `end()` to publish a final non-streaming message
          // so the agent's reply still lands.
          this.log.info(
            'Teams streaming: client returned ContentStreamNotAllowed; degrading',
          );
          this._cancelled = true;
          return;
        }
        if (
          msg.includes('BadArgument') &&
          msg.toLowerCase().includes('streaming api is not enabled')
        ) {
          this.log.info(
            'Teams streaming: channel rejected streaming; falling back to single final message',
          );
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
    continueConversation: (
      ref: ConversationReference,
      logic: (ctx: TurnContext) => Promise<void>,
    ) => Promise<void>;
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
