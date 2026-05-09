/**
 * v2 channel-adapter side-effect barrel.
 *
 * Phase B.4-finish of v2-merge. Importing this file fires the
 * `registerChannelAdapter()` calls at the bottom of each v2 adapter
 * module, populating the v2 `channel-registry` (`./channel-registry.ts`)
 * with the discord/telegram/teams adapters that wrap fork's
 * native `DiscordChannel` / `TelegramChannel` / `TeamsChannel`.
 *
 * Why a *separate* barrel rather than appending to
 * `./index.ts`: the existing `index.ts` is the fork's channel
 * self-registration barrel — its imports drive `registerChannel()`
 * on the **fork** registry (`./registry.ts`) and bring the
 * platforms up under the v1 dispatcher. If both barrels were
 * folded together, every process startup would attempt **two**
 * independent gateway connections per platform (one for the fork
 * dispatcher, one for the v2 router) and both would fight over
 * the same auth token / port / inbound webhook URL.
 *
 * Until B.5 router merge, *only the fork barrel* gets imported by
 * `src/index.ts`. This file exists so:
 *   1. unit tests can import it to populate the v2 registry without
 *      touching the fork registry, and
 *   2. once B.5 swaps the dispatcher, the import site flips
 *      from `./index.js` to `./adapters-barrel.js` in one line.
 *
 * No re-exports, no logic — pure side-effect imports.
 */

import './discord-adapter.js';
import './telegram-adapter.js';
import './teams-adapter.js';
