/**
 * nanoclaw reload — ask the running daemon to re-read nanoclaw.json
 *
 * Usage:
 *   nanoclaw reload
 *
 * Behavior:
 *   - On POSIX: sends SIGUSR2 to the daemon pid (same handler as
 *     `nanoclaw loglevel <x>`). The handler calls reloadConfig() which
 *     refreshes the in-memory _config used by host-runner, channels,
 *     MCP server resolution, etc.
 *   - On Windows: writes ~/.nanoclaw/state/reload.trigger; the daemon
 *     polls for it and reloads when it appears.
 *   - If the daemon is not running, says so and exits 0 (config will be
 *     read fresh on next start anyway).
 *
 * Use cases (this is a generic escape hatch):
 *   - After editing nanoclaw.json by hand
 *   - After `nanoclaw mcp add/remove` (which already calls this internally,
 *     but a manual re-trigger is fine)
 *   - After tweaking channels.* / agents.* without wanting full restart
 *
 * Caveat: not every config field is hot-reloadable. Channel auth tokens,
 * port bindings, etc. still need a real restart. This command refreshes
 * the in-memory config; whether subsystems re-read it on the fly is a
 * per-subsystem concern.
 */

import { signalReload } from '../daemon-signal.js';

export async function runReload(_args: string[]): Promise<void> {
  const result = signalReload();

  if (result.noDaemon) {
    console.log(
      'Daemon not running — nothing to reload. Config will be read fresh on next `nanoclaw start`.',
    );
    return;
  }

  if (!result.delivered) {
    console.error(
      `Failed to trigger reload${result.pid ? ` (pid ${result.pid})` : ''}: ${result.error || 'unknown error'}.`,
    );
    console.error('Run `nanoclaw restart` to apply config changes.');
    process.exit(1);
  }

  if (result.method === 'trigger-file') {
    console.log('Wrote reload trigger; daemon will reload config within ~2s.');
  } else {
    console.log(
      `Sent SIGUSR2 to daemon (pid ${result.pid}); reload requested.`,
    );
  }
}
