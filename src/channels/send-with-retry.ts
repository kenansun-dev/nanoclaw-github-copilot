import { logger } from '../log-extensions.js';

/**
 * Retry policy for transient channel send failures.
 *
 * Default backoff: 500ms → 2s → 5s (3 attempts after initial = 4 total tries).
 * Total worst-case wait before giving up: ~7.5s.
 *
 * Why these numbers:
 *   - 500ms covers transient single-packet drops / brief network blips
 *   - 2s covers most rate-limit (429) windows for Discord/Telegram normal tier
 *   - 5s is the last desperate try before we surface the failure to the user
 *
 * We deliberately do NOT retry forever: messaging platforms have stricter rate
 * limits than the agent's reply rate, and a stuck send queue causes worse UX
 * (cascading delays + duplicate messages) than a clear "⚠️ delivery failed".
 */
export const DEFAULT_BACKOFF_MS = [500, 2000, 5000];

/**
 * Errors we should NOT retry — these will never succeed by retrying.
 * Caller-side bugs (bad payload, missing channel, auth) should fail fast.
 */
function isPermanentError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message ?? err).toLowerCase();
  const code = err?.status ?? err?.code ?? err?.statusCode;

  // 4xx client errors that won't resolve via retry
  if (typeof code === 'number' && code >= 400 && code < 500) {
    // 408 Request Timeout and 429 Too Many Requests ARE retryable
    if (code === 408 || code === 429) return false;
    return true;
  }

  // Common permanent-error patterns from Discord/Telegram/Teams SDKs
  if (msg.includes('unauthorized')) return true;
  if (msg.includes('forbidden')) return true;
  if (msg.includes('not found') && !msg.includes('temporarily')) return true;
  if (msg.includes('invalid token')) return true;
  if (msg.includes('bot was blocked')) return true; // Telegram
  if (msg.includes('chat not found')) return true; // Telegram
  if (msg.includes('user is deactivated')) return true; // Telegram
  // 'message is not modified' is technically an editMessage NO-OP SUCCESS,
  // not a true failure. We list it here so callers using sendWithRetry around
  // editMessage don't burn 3 retries + 7s on a successful no-op.
  // ⚠️ Caveat: each channel's editMessage already locally catches this case
  // and returns success, so today no caller actually relies on this branch.
  // If a future caller does `sendWithRetry(() => api.editMessage(...))` raw,
  // the call will THROW from here (treating no-op as failure) and the caller
  // must handle it as success — otherwise it'll fall back to a duplicate send.
  // See PR #9 review thread for context.
  if (msg.includes('message is not modified')) return true; // Telegram edit no-op

  return false;
}

export interface SendWithRetryOptions {
  /** Override backoff intervals (default DEFAULT_BACKOFF_MS). */
  backoffMs?: number[];
  /** Tag for log context (e.g. `'discord.sendMessage'`). */
  opName: string;
  /** Identifier of the target (e.g. JID) for log context. */
  jid?: string;
  /** Optional logger override. */
  log?: typeof logger;
}

/**
 * Run an async send op with exponential-backoff retry on transient errors.
 *
 * Returns the operation's result on success, or rethrows the last error
 * after exhausting retries. The caller is responsible for surfacing the
 * final failure to the user (e.g. via a "⚠️ undelivered" notice).
 *
 * Tested in send-with-retry.test.ts.
 */
export async function sendWithRetry<T>(
  fn: () => Promise<T>,
  opts: SendWithRetryOptions,
): Promise<T> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const log = opts.log ?? logger;
  let lastErr: any;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;

      if (isPermanentError(err)) {
        log.warn(
          { op: opts.opName, jid: opts.jid, err: err?.message ?? String(err) },
          'send op failed with non-retryable error, giving up',
        );
        throw err;
      }

      if (attempt === backoff.length) {
        // Final attempt failed — caller surfaces to user.
        log.warn(
          {
            op: opts.opName,
            jid: opts.jid,
            attempts: attempt + 1,
            err: err?.message ?? String(err),
          },
          'send op failed after all retries',
        );
        throw err;
      }

      const delayMs = backoff[attempt];
      log.info(
        {
          op: opts.opName,
          jid: opts.jid,
          attempt: attempt + 1,
          nextDelayMs: delayMs,
          err: err?.message ?? String(err),
        },
        'send op failed transiently, retrying',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Unreachable, but keeps TS happy.
  throw lastErr;
}
