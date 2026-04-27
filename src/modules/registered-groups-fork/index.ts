/**
 * Registered groups (fork add-on) — module skeleton.
 *
 * Thin v2-shaped re-export of the fork's `getRegisteredGroup` /
 * `setRegisteredGroup` / `getAllRegisteredGroups` / `removeRegisteredGroup`
 * helpers (currently exported from `src/db.ts`). Exists so that B.5
 * (router merge) has a stable module path for group resolution
 * registration. Today this is a no-op other than the export — fork
 * v1 dispatcher in `src/index.ts` still imports from `db.ts`
 * directly.
 *
 * Why a separate "fork add-on" module: the v2 router uses
 * `routeMessage` with a chat-id-only contract; our fork adds the
 * `RegisteredGroup` concept (per-chat folder + cli-agent + skills
 * binding loaded from SQLite). B.5 will wire this module so the
 * router can ask "which group does this chat belong to?" via the
 * registered group table without `src/router.ts` having to import
 * `db.ts` directly.
 *
 * Wiring plan (B.5):
 *   - Router exposes `registerGroupResolver(fn)` (v2 surface).
 *   - This module imports `getRegisteredGroup` from `../../db.js`
 *     and registers a resolver that looks up the chat jid.
 *   - The router caches the result per-message and passes it to
 *     downstream hooks via the routing context.
 *
 * Until B.5: do not register anything. Importing this module is a
 * no-op other than re-exporting the existing helpers under their v2
 * module path.
 */
import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
  removeRegisteredGroup,
} from '../../db.js';

export const registeredGroupsFork = {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
  removeRegisteredGroup,
};

// B.5 will replace this with:
//   import { registerGroupResolver } from '../../router.js';
//   registerGroupResolver((chatJid) => getRegisteredGroup(chatJid));
