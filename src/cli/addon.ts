/**
 * Addon management — track external resources (tunnels, Azure apps, bots, tasks)
 * associated with channels. Stored in nanoclaw.json under `addons`.
 *
 * Usage:
 *   nanoclaw addon list                    — list all addons
 *   nanoclaw addon remove <name>           — remove an addon (and clean up)
 *   nanoclaw addon stop <name>             — stop a running addon
 *   nanoclaw addon start <name>            — start a stopped addon
 */

import { execSync, spawn } from 'child_process';
import { loadConfig, saveConfig } from '../config-loader.js';
import { logger } from '../log-extensions.js';

export interface Addon {
  type: string;
  channel?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt?: string;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function registerAddon(
  name: string,
  addon: Omit<Addon, 'createdAt'>,
): void {
  const config = loadConfig();
  if (!config.addons) config.addons = {};
  config.addons[name] = {
    ...addon,
    createdAt: new Date().toISOString(),
  };
  saveConfig(config);
  logger.info({ name, type: addon.type }, 'Addon registered');
}

export function removeAddon(name: string): void {
  const config = loadConfig();
  if (!config.addons || !config.addons[name]) {
    console.log(`Addon '${name}' not found.`);
    return;
  }

  const addon = config.addons[name];

  // Clean up based on type
  try {
    if (addon.type === 'devtunnel' && addon.config.tunnelId) {
      console.log(`Deleting devtunnel ${addon.config.tunnelId}...`);
      try {
        execSync(`devtunnel delete ${addon.config.tunnelId} -f`, {
          stdio: 'pipe',
        });
        console.log('  ✅ Tunnel deleted');
      } catch {
        console.log('  ⚠️  Could not delete tunnel (may already be gone)');
      }
    }

    if (addon.type === 'azure-app' && addon.config.appId) {
      console.log(`Deleting Azure AD App ${addon.config.appId}...`);
      try {
        execSync(`az ad app delete --id "${addon.config.appId}"`, {
          stdio: 'pipe',
        });
        console.log('  ✅ App registration deleted');
      } catch {
        console.log('  ⚠️  Could not delete app (may need az login)');
      }
    }

    if (addon.type === 'azure-bot' && addon.config.botName) {
      const rg = (addon.config.resourceGroup as string) || 'nanoclaw-rg';
      console.log(`Deleting Azure Bot ${addon.config.botName}...`);
      try {
        execSync(
          `az bot delete --resource-group "${rg}" --name "${addon.config.botName}"`,
          { stdio: 'pipe' },
        );
        console.log('  ✅ Bot deleted');
      } catch {
        console.log('  ⚠️  Could not delete bot');
      }
    }

    if (addon.type === 'scheduled-task' && addon.config.taskName) {
      console.log(`Removing scheduled task ${addon.config.taskName}...`);
      try {
        if (process.platform === 'win32') {
          execSync(`schtasks /Delete /TN "${addon.config.taskName}" /F`, {
            stdio: 'pipe',
          });
        } else {
          execSync(
            `systemctl --user stop ${addon.config.taskName} 2>/dev/null; systemctl --user disable ${addon.config.taskName} 2>/dev/null`,
            { stdio: 'pipe' },
          );
        }
        console.log('  ✅ Task removed');
      } catch {
        console.log('  ⚠️  Could not remove task');
      }
    }
  } catch {
    /* best effort cleanup */
  }

  delete config.addons[name];
  saveConfig(config);
  console.log(`✅ Addon '${name}' removed.`);
}

export function listAddons(): void {
  const config = loadConfig();
  const addons = config.addons || {};
  const entries = Object.entries(addons);

  if (entries.length === 0) {
    console.log('No addons registered.');
    return;
  }

  console.log('\n🔌 Registered Addons:\n');
  for (const [name, addon] of entries) {
    const status = addon.enabled ? '✅' : '⏸️';
    const channel = addon.channel ? ` (${addon.channel})` : '';
    console.log(`  ${status} ${name} — ${addon.type}${channel}`);

    // Show key config details
    if (addon.type === 'devtunnel' && addon.config.tunnelId) {
      console.log(`     Tunnel: ${addon.config.tunnelId}`);
      if (addon.config.url) console.log(`     URL: ${addon.config.url}`);
    }
    if (addon.type === 'azure-app' && addon.config.appId) {
      console.log(
        `     App ID: ${(addon.config.appId as string).substring(0, 8)}...`,
      );
    }
    if (addon.type === 'azure-bot' && addon.config.botName) {
      console.log(`     Bot: ${addon.config.botName}`);
    }
    if (addon.config.taskName) {
      console.log(`     Task: ${addon.config.taskName}`);
    }
  }
  console.log('');
}

export function stopAddon(name: string): void {
  const config = loadConfig();
  const addon = config.addons?.[name];
  if (!addon) {
    console.log(`Addon '${name}' not found.`);
    return;
  }

  if (addon.type === 'devtunnel' && addon.config.tunnelId) {
    // Kill devtunnel process if running
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /IM devtunnel.exe', { stdio: 'pipe' });
      } else {
        execSync('pkill -f "devtunnel host"', { stdio: 'pipe' });
      }
      console.log(`✅ Stopped ${name}`);
    } catch {
      console.log(`⚠️  Could not stop ${name} (may not be running)`);
    }
  }

  addon.enabled = false;
  saveConfig(config);
}

export async function startAddon(name: string): Promise<void> {
  const config = loadConfig();
  const addon = config.addons?.[name];
  if (!addon) {
    console.log(`Addon '${name}' not found.`);
    return;
  }

  if (addon.type === 'devtunnel' && addon.config.tunnelId) {
    try {
      const tid = String(addon.config.tunnelId);
      const dt = spawn('devtunnel', ['host', tid, '--allow-anonymous'], {
        detached: true,
        stdio: 'ignore',
      });
      if (dt.pid) dt.unref();
      console.log(`✅ Started ${name} (pid: ${dt.pid})`);
    } catch {
      console.log(`⚠️  Could not start ${name}`);
    }
  }

  addon.enabled = true;
  saveConfig(config);
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

export async function runAddonCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      listAddons();
      break;
    case 'remove':
    case 'rm':
      if (!args[1]) {
        console.log('Usage: nanoclaw addon remove <name>');
        return;
      }
      removeAddon(args[1]);
      break;
    case 'stop':
      if (!args[1]) {
        console.log('Usage: nanoclaw addon stop <name>');
        return;
      }
      stopAddon(args[1]);
      break;
    case 'start':
      if (!args[1]) {
        console.log('Usage: nanoclaw addon start <name>');
        return;
      }
      startAddon(args[1]);
      break;
    default:
      console.log('Usage: nanoclaw addon <list|remove|stop|start> [name]');
      console.log('');
      console.log('Commands:');
      console.log('  list              List all registered addons');
      console.log('  remove <name>     Remove an addon and clean up resources');
      console.log('  stop <name>       Stop a running addon');
      console.log('  start <name>      Start a stopped addon');
  }
}
