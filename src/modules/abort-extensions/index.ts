/**
 * Abort triggers (fork add-on) — module wire-up.
 *
 * Registers the fork's pre-LLM fast-abort keyword check ('stop' /
 * 'cancel' / '停' etc.) with the abort-handler registry. v2 has no
 * inbound fast-abort concept — its agent kill path goes through the
 * agent's own cancelTask/approvals flow (which costs an LLM
 * round-trip). This module's matcher fires BEFORE any router gate
 * runs, so the running container can be killed cheaply.
 *
 * The actual `onAbort` action (queue.killActive + send ack) is
 * provided by the dispatcher caller via `installAbortFork(deps)` —
 * the registry stays dependency-free and tests inject mocks.
 */
import { isAbortRequestText } from '../../abort-triggers.js';
import {
  registerAbortHandler,
  type AbortMessage,
} from '../../abort-handler-registry.js';
import { log } from '../../log.js';

export const abortFork = {
  isAbortRequestText,
};

export interface AbortForkDeps {
  /** Kill the active agent for this chat. Return true iff something was killed. */
  killActive: (chatJid: string) => boolean | Promise<boolean>;
  /** Optional ack send after a successful kill (default no-op). */
  sendAck?: (chatJid: string, text: string) => void | Promise<void>;
  /** Override the matcher (tests). */
  matcher?: (text: string) => boolean;
}

let installed = false;

/**
 * Install the fork abort handler into the registry. Idempotent —
 * subsequent calls are no-ops so accidental double-import doesn't
 * stack handlers.
 */
export function installAbortFork(deps: AbortForkDeps): void {
  if (installed) return;
  installed = true;

  const matcher = deps.matcher ?? isAbortRequestText;

  registerAbortHandler({
    matcher: (text: string) => matcher(text),
    onAbort: async (chatJid: string, msg: AbortMessage) => {
      try {
        const wasActive = await deps.killActive(chatJid);
        if (wasActive) {
          log.info('fast-abort triggered', { chatJid, text: msg.content });
          if (deps.sendAck) {
            try {
              await deps.sendAck(chatJid, '⚙️ Agent aborted.');
            } catch (err) {
              log.warn('abort: failed to send ack', { err, chatJid });
            }
          }
        }
      } catch (err) {
        log.warn('abort: killActive failed', { err, chatJid });
      }
    },
  });
}

/** Test-only: re-allow installAbortFork to register again. */
export function __resetAbortForkInstalledForTests(): void {
  installed = false;
}
