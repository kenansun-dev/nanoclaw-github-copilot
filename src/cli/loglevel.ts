/**
 * nanoclaw loglevel — view or change the log level at runtime
 *
 * Usage:
 *   nanoclaw loglevel                 Show current effective level + source
 *   nanoclaw loglevel <level>         Set level (debug|info|warn|error|fatal)
 *
 * Behavior:
 *   - Writes the new value to `~/.nanoclaw/nanoclaw.json` under `logLevel`
 *   - If the daemon is running, sends SIGUSR2 to apply live (no restart)
 *   - If the daemon is not running, the value takes effect on next start
 *   - Note: env LOG_LEVEL on the daemon process always wins; this command
 *     forces an override on the next SIGUSR2 reload.
 */

import fs from 'fs';
import { paths } from '../workspace.js';
import { getValidLevels } from '../logger.js';
import { readPid, signalReload } from '../daemon-signal.js';

const VALID = getValidLevels();

function readConfig(): any {
  const configPath = paths.config;
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}. Run "nanoclaw init" first.`,
    );
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(config: any): void {
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n');
}

export async function runLogLevel(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub) {
    // Show current
    const cfg = readConfig();
    const configLevel = cfg.logLevel || '(unset)';
    const envLevel = process.env.LOG_LEVEL;
    const pid = readPid();
    const running = pid !== null;
    console.log(`Configured (nanoclaw.json): ${configLevel}`);
    if (envLevel) {
      console.log(
        `Environment LOG_LEVEL:      ${envLevel}  ⚠️  env LOG_LEVEL is set on daemon; \`loglevel <x>\` will override on next SIGUSR2`,
      );
    }
    console.log(
      `Daemon:                     ${running ? `running (pid ${pid})` : 'not running'}`,
    );
    console.log(`Valid levels:               ${VALID.join(' | ')}`);
    return;
  }

  const level = sub.toLowerCase();
  if (!VALID.includes(level as any)) {
    console.error(`Invalid log level: ${sub}. Valid: ${VALID.join(', ')}`);
    process.exit(1);
  }

  // Write to config
  const cfg = readConfig();
  const previous = cfg.logLevel;
  cfg.logLevel = level;
  writeConfig(cfg);

  if (previous === level) {
    console.log(`Log level already ${level} in config (no change).`);
  } else {
    console.log(
      `Log level set to ${level} in nanoclaw.json (was ${previous ?? 'unset'}).`,
    );
  }

  // Try live reload via SIGUSR2 (or Windows trigger-file fallback).
  const result = signalReload();
  if (result.noDaemon) {
    console.log('Daemon not running — value will take effect on next start.');
    return;
  }
  if (!result.delivered) {
    console.error(
      `Failed to signal daemon${result.pid ? ` (pid ${result.pid})` : ''}: ${result.error || 'unknown'}. Restart with "nanoclaw restart" to apply.`,
    );
    process.exit(1);
  }
  if (result.method === 'trigger-file') {
    console.log(
      'Wrote reload trigger; daemon will pick up the change shortly.',
    );
  } else {
    console.log(`Sent SIGUSR2 to daemon (pid ${result.pid}); change is live.`);
  }
}
