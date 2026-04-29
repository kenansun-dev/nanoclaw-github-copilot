// Channel self-registration barrel file.
//
// Two registries co-exist during the v1→v2 dispatcher migration:
// - v1 path (`./registry.js`): discord/telegram/teams/tui self-register here.
//   Drives the legacy dispatcher loop in `src/index.ts`.
// - v2 path (`./channel-registry.js`): cli (and future ports) self-register
//   here. Drives the v2 dispatcher (NANOCLAW_V2_DISPATCHER env-gated).
// When the v2 dispatcher is the default, v1 self-registrations below can be
// deleted alongside the matching channel files.

// --- v1 channels (legacy registry.ts) ---
// discord
import './discord.js';

// telegram
import './telegram.js';

// teams
import './teams.js';

// tui
import './tui.js';

// --- v2 channels (channel-registry.ts) ---
import './cli.js';
