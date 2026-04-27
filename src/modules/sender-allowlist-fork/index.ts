/**
 * Sender allowlist (fork add-on) — module skeleton.
 *
 * Thin v2-shaped re-export of the fork's existing
 * `src/sender-allowlist.ts` so that B.5 (router merge with
 * `setSenderResolver` / `setAccessGate` hooks) has a stable module
 * path to register against. Today it is a no-op except for the
 * export — the fork v1 dispatcher in `src/index.ts` still calls
 * `isSenderAllowed` directly.
 *
 * Why a separate "fork add-on" module instead of replacing v2
 * permissions: kenan 23:20 policy = "全收 v2 features"; v2 already has
 * `src/modules/permissions/` with its own access-gate semantics. The
 * fork allowlist (per-chat allow/deny + trigger/drop mode loaded from
 * `data/sender_allowlist.json`) is an *additional* layer on top, not
 * a replacement. Keeping it in its own module makes the layering
 * explicit and lets B.5 wire two access gates in series rather than
 * mutating permissions/.
 *
 * Wiring plan (B.5):
 *   - Router exposes `registerAccessGate(fn)` (v2 surface).
 *   - This module imports `isSenderAllowed` from
 *     `../../sender-allowlist.js` and registers a gate that returns
 *     `false` when the sender is denied.
 *   - The router then runs gates in registration order; v2
 *     permissions remains the primary, this becomes a secondary.
 *
 * Until B.5: do not register anything. Importing this module is a
 * no-op other than re-exporting the existing helpers under their v2
 * module path so other code can depend on the symbol path.
 */
import {
  isSenderAllowed,
  loadSenderAllowlist,
} from '../../sender-allowlist.js';

export const senderAllowlistFork = {
  isSenderAllowed,
  loadSenderAllowlist,
};

// B.5 will replace this with:
//   import { registerAccessGate } from '../../router.js';
//   registerAccessGate((ctx) => {
//     const cfg = loadSenderAllowlist();
//     return isSenderAllowed(ctx.chatJid, ctx.senderId, cfg);
//   });
