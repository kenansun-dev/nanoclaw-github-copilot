/**
 * Bounded typing pulse state machine.
 *
 * Extracted from src/index.ts so unit tests can exercise the real timer
 * + cancellation logic instead of grepping the source file for string
 * literals (the previous test pattern in dispatcher-typing-*.test.ts).
 *
 * Behavior:
 *   - armTypingBounded(channel, jid, ttlMs): turns typing ON, schedules
 *     an auto-clear after ttlMs.
 *   - cancelBoundedTypingClear(jid): defuses any pending auto-clear so a
 *     follow-on event (next thinking/final/turn-end/finally-guard) does
 *     not double-toggle.
 *   - The auto-clear callback turns typing OFF if no one cancelled it.
 *
 * Why this exists (kenan repro 2026-04-27): the original re-arm armed an
 * unbounded keepalive after every interim final-output, including the
 * last one, so the typing indicator stayed on during the gap before
 * turn-end. The bounded pulse caps that gap.
 */

export interface TypingChannel {
  name: string;
  setTyping?: (jid: string, isTyping: boolean) => Promise<void>;
}

export interface TypingPulseLogger {
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
}

const NOOP_LOGGER: TypingPulseLogger = {};

/**
 * Internal state container. Exported as a factory so tests can have an
 * isolated state map per test without leaking globals.
 */
export interface TypingPulseState {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  logger: TypingPulseLogger;
}

export function createTypingPulseState(
  logger: TypingPulseLogger = NOOP_LOGGER,
): TypingPulseState {
  return { timers: new Map(), logger };
}

export function cancelBoundedTypingClear(
  state: TypingPulseState,
  chatJid: string,
): void {
  const t = state.timers.get(chatJid);
  if (t) {
    clearTimeout(t);
    state.timers.delete(chatJid);
  }
}

/**
 * Returns true if a bounded pulse is currently armed for chatJid.
 * Test-only convenience; production code should not rely on this.
 */
export function hasPendingTypingClear(
  state: TypingPulseState,
  chatJid: string,
): boolean {
  return state.timers.has(chatJid);
}

export async function armTypingBounded(
  state: TypingPulseState,
  channel: TypingChannel,
  chatJid: string,
  ttlMs: number,
): Promise<void> {
  // Cancel any existing pulse before installing a fresh one.
  cancelBoundedTypingClear(state, chatJid);
  if (channel.setTyping) {
    try {
      await channel.setTyping(chatJid, true);
    } catch (err: any) {
      state.logger.warn?.(
        { chatJid, channel: channel.name, err: err?.message ?? err },
        'bounded typing arm failed',
      );
    }
  }
  const t = setTimeout(() => {
    state.timers.delete(chatJid);
    if (channel.setTyping) {
      channel.setTyping(chatJid, false).catch((err: any) => {
        state.logger.warn?.(
          { chatJid, channel: channel.name, err: err?.message ?? err },
          'bounded typing auto-clear failed',
        );
      });
    }
  }, ttlMs);
  state.timers.set(chatJid, t);
}
