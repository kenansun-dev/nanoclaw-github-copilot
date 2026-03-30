/**
 * nanoclaw service — install/uninstall/status as system service
 *
 * Linux: systemd user service
 * macOS: launchd plist
 * Windows: Scheduled Task (user-level)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { resolveWorkspace } from '../workspace.js';

const SERVICE_NAME = 'nanoclaw';
const DEVTUNNEL_SERVICE_NAME = 'nanoclaw-devtunnel';

function getNodePath(): string {
  return process.execPath;
}

function getNanoclawBin(): string {
  // Find the nanoclaw CLI entry point
  try {
    return execSync('which nanoclaw 2>/dev/null || where nanoclaw 2>nul', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0];
  } catch {
    return 'nanoclaw';
  }
}

// ─── Linux: systemd user service ─────────────────────────────────────────────

function systemdServiceContent(description: string, execStart: string, ws: string): string {
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
Environment=NANOCLAW_WORKSPACE=${ws}
WorkingDirectory=${ws}

[Install]
WantedBy=default.target
`;
}

function installSystemd(ws: string, tunnelId?: string): void {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });

  // NanoClaw service
  const nanoclawEntry = getNanoclawBin();
  const nanoclawService = systemdServiceContent(
    'NanoClaw AI Assistant',
    `${getNodePath()} ${nanoclawEntry} start --foreground`,
    ws,
  );
  const nanoclawPath = path.join(serviceDir, `${SERVICE_NAME}.service`);
  fs.writeFileSync(nanoclawPath, nanoclawService);
  console.log(`  Created: ${nanoclawPath}`);

  // DevTunnel service (optional)
  if (tunnelId) {
    const devtunnelBin = execSync('which devtunnel', { encoding: 'utf-8' }).trim();
    const devtunnelService = systemdServiceContent(
      'NanoClaw DevTunnel',
      `${devtunnelBin} host ${tunnelId} --allow-anonymous`,
      ws,
    );
    const devtunnelPath = path.join(serviceDir, `${DEVTUNNEL_SERVICE_NAME}.service`);
    fs.writeFileSync(devtunnelPath, devtunnelService);
    console.log(`  Created: ${devtunnelPath}`);
  }

  // Reload + enable
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' });
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' });
  console.log(`  ✅ ${SERVICE_NAME} enabled + started`);

  if (tunnelId) {
    execSync(`systemctl --user enable ${DEVTUNNEL_SERVICE_NAME}`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${DEVTUNNEL_SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(`  ✅ ${DEVTUNNEL_SERVICE_NAME} enabled + started`);
  }

  // Enable linger so services run without login
  try {
    const user = os.userInfo().username;
    execSync(`loginctl enable-linger ${user}`, { stdio: 'pipe' });
    console.log(`  ✅ Linger enabled for ${user}`);
  } catch {
    console.log('  ⚠️  Could not enable linger (services may stop on logout)');
  }
}

function uninstallSystemd(): void {
  try { execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* */ }
  try { execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* */ }
  try { execSync(`systemctl --user stop ${DEVTUNNEL_SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* */ }
  try { execSync(`systemctl --user disable ${DEVTUNNEL_SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* */ }

  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    const p = path.join(serviceDir, `${name}.service`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`  Removed: ${p}`); }
  }
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  console.log('  ✅ Services uninstalled');
}

function statusSystemd(): void {
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      const output = execSync(`systemctl --user is-active ${name}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      console.log(`  ${name}: ${output}`);
    } catch {
      console.log(`  ${name}: not installed`);
    }
  }
}

// ─── Windows: Scheduled Task ────────────────────────────────────────────────

function installWindows(ws: string, tunnelId?: string): void {
  const nanoclawBin = getNanoclawBin();

  // NanoClaw task — runs at logon
  try {
    execSync(
      `schtasks /Create /TN "${SERVICE_NAME}" /TR "${getNodePath()} ${nanoclawBin} start --foreground" /SC ONLOGON /RL HIGHEST /F`,
      { stdio: 'pipe' },
    );
    console.log(`  ✅ ${SERVICE_NAME} scheduled task created (runs at logon)`);
  } catch (err) {
    // Fallback: Startup folder
    console.log('  ⚠️  Scheduled Task creation failed, using Startup folder');
    const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    fs.mkdirSync(startupDir, { recursive: true });
    const batFile = path.join(startupDir, `${SERVICE_NAME}.bat`);
    fs.writeFileSync(batFile, `@echo off\ncd /d "${ws}"\n"${getNodePath()}" "${nanoclawBin}" start --foreground\n`);
    console.log(`  ✅ Created startup script: ${batFile}`);
  }

  // DevTunnel task
  if (tunnelId) {
    try {
      const devtunnelBin = execSync('where devtunnel', { encoding: 'utf-8' }).trim().split('\n')[0];
      execSync(
        `schtasks /Create /TN "${DEVTUNNEL_SERVICE_NAME}" /TR "${devtunnelBin} host ${tunnelId} --allow-anonymous" /SC ONLOGON /RL HIGHEST /F`,
        { stdio: 'pipe' },
      );
      console.log(`  ✅ ${DEVTUNNEL_SERVICE_NAME} scheduled task created`);
    } catch {
      console.log('  ⚠️  DevTunnel scheduled task creation failed');
    }
  }
}

function uninstallWindows(): void {
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      execSync(`schtasks /Delete /TN "${name}" /F`, { stdio: 'pipe' });
      console.log(`  Removed scheduled task: ${name}`);
    } catch { /* */ }
  }

  // Also check Startup folder
  const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const batFile = path.join(startupDir, `${SERVICE_NAME}.bat`);
  if (fs.existsSync(batFile)) { fs.unlinkSync(batFile); console.log(`  Removed: ${batFile}`); }
  console.log('  ✅ Services uninstalled');
}

function statusWindows(): void {
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      const output = execSync(`schtasks /Query /TN "${name}" /FO CSV /NH`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const status = output.includes('Running') ? 'running' : output.includes('Ready') ? 'ready' : 'unknown';
      console.log(`  ${name}: ${status}`);
    } catch {
      console.log(`  ${name}: not installed`);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runServiceCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || 'status';
  const ws = resolveWorkspace();

  // Parse --devtunnel <id>
  let tunnelId: string | undefined;
  const dtIdx = args.indexOf('--devtunnel');
  if (dtIdx !== -1 && args[dtIdx + 1]) {
    tunnelId = args[dtIdx + 1];
  }

  const platform = process.platform;

  switch (subcommand) {
    case 'install': {
      console.log(`Installing NanoClaw as service (${platform})...`);
      if (platform === 'win32') {
        installWindows(ws, tunnelId);
      } else if (platform === 'linux') {
        installSystemd(ws, tunnelId);
      } else if (platform === 'darwin') {
        console.log('  macOS launchd support not yet implemented.');
        console.log('  Use: nanoclaw start (manual)');
      } else {
        console.log(`  Unsupported platform: ${platform}`);
      }
      break;
    }
    case 'uninstall': {
      console.log('Uninstalling NanoClaw service...');
      if (platform === 'win32') { uninstallWindows(); }
      else if (platform === 'linux') { uninstallSystemd(); }
      else { console.log(`  Unsupported platform: ${platform}`); }
      break;
    }
    case 'status':
    default: {
      console.log('Service status:');
      if (platform === 'win32') { statusWindows(); }
      else if (platform === 'linux') { statusSystemd(); }
      else { console.log(`  Unsupported platform: ${platform}`); }
      break;
    }
  }
}
