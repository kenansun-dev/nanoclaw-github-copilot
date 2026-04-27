/**
 * Abort triggers (fork add-on) — module skeleton.
 *
 * Thin v2-shaped re-export of the fork's existing
 * `src/abort-triggers.ts` so that B.5 (router merge / agent-runner
 * main wire-up) has a stable module path to register against.
 *
 * Why a separate "fork add-on" module: v2 has no inbound fast-abort
 * concept — its agent kill path goes through the agent's own
 * `cancelTask` / approvals flow (i.e. an abort still costs an LLM
 * round-trip to interpret). The fork's `isAbortRequestText` is a
 * pre-routing keyword check that lets the host kill the running
 * container BEFORE the message reaches the LLM (so 'stop' / '停' are
 * cheap interrupts). Keeping it as a separate module makes the
 * "host-side fast path before module gates" layering explicit.
 *
 * Wiring plan (B.5 / C.2 wire-up phase):
 *   - The host inbound handler imports `isAbortRequestText` from
 *     this module's `abortFork.isAbortRequestText` and short-circuits
 *     before any router gate or agent invocation.
 *   - Triggers list stays in `src/abort-triggers.ts` for now (one
 *     source of truth); a follow-up can move it here once no other
 *     code path imports the original.
 *
 * Until wire-up: do not register anything. Importing this module is
 * a no-op other than re-exporting the helper under its v2 module
 * path.
 */
import { isAbortRequestText } from '../../abort-triggers.js';

export const abortFork = {
  isAbortRequestText,
};
