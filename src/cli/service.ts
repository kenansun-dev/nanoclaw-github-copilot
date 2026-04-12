/**
 * nanoclaw service — install/uninstall/status as system service
 *
 * Linux: systemd user service
 * macOS: launchd plist
 * Windows: Scheduled Task (user-level)
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { resolveWorkspace } from '../workspace.js';

const SERVICE_NAME = 'nanoclaw';
const DEVTUNNEL_SERVICE_NAME = 'nanoclaw-devtunnel';

function getNodePath(): string {
  return process.execPath;
}

function resolveNanoclawBin(): string {
  // Resolve from package installation path (works in service context where PATH may be limited)
  const pkgBin = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    'bin',
    'nanoclaw.js',
  );
  if (fs.existsSync(pkgBin)) return `${getNodePath()} ${pkgBin}`;
  // Fallback to PATH
  try {
    const cmd =
      process.platform === 'win32' ? 'where nanoclaw' : 'which nanoclaw';
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim()
      .split('\n')[0];
  } catch {
    return 'nanoclaw';
  }
}

// ─── Linux: systemd user service ─────────────────────────────────────────────

function systemdServiceContent(
  description: string,
  execStart: string,
  ws: string,
): string {
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

async function installSystemd(ws: string, tunnelId?: string): Promise<void> {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });

  // NanoClaw service
  const nanoclawEntry = resolveNanoclawBin();
  const nanoclawService = systemdServiceContent(
    'NanoClaw AI Assistant',
    `${nanoclawEntry} dev`,
    ws,
  );
  const nanoclawPath = path.join(serviceDir, `${SERVICE_NAME}.service`);
  fs.writeFileSync(nanoclawPath, nanoclawService);
  console.log(`  Created: ${nanoclawPath}`);

  // DevTunnel service (optional)
  if (tunnelId) {
    const devtunnelBin = execSync('which devtunnel', {
      encoding: 'utf-8',
    }).trim();
    const devtunnelService = systemdServiceContent(
      'NanoClaw DevTunnel',
      `${devtunnelBin} host ${tunnelId} --allow-anonymous`,
      ws,
    );
    const devtunnelPath = path.join(
      serviceDir,
      `${DEVTUNNEL_SERVICE_NAME}.service`,
    );
    fs.writeFileSync(devtunnelPath, devtunnelService);
    console.log(`  Created: ${devtunnelPath}`);
  }

  // Reload + enable
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' });
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' });
  // Health check
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const status = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    console.log(`  ✅ ${SERVICE_NAME}: ${status}`);
  } catch {
    console.log(
      '  ⚠️  Service started but may not be healthy. Check: nanoclaw service status',
    );
  }

  if (tunnelId) {
    execSync(`systemctl --user enable ${DEVTUNNEL_SERVICE_NAME}`, {
      stdio: 'pipe',
    });
    execSync(`systemctl --user start ${DEVTUNNEL_SERVICE_NAME}`, {
      stdio: 'pipe',
    });
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
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    /* */
  }
  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    /* */
  }
  try {
    execSync(`systemctl --user stop ${DEVTUNNEL_SERVICE_NAME}`, {
      stdio: 'pipe',
    });
  } catch {
    /* */
  }
  try {
    execSync(`systemctl --user disable ${DEVTUNNEL_SERVICE_NAME}`, {
      stdio: 'pipe',
    });
  } catch {
    /* */
  }

  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    const p = path.join(serviceDir, `${name}.service`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  Removed: ${p}`);
    }
  }
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  console.log('  ✅ Services uninstalled');
}

function statusSystemd(): void {
  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      const output = execSync(`systemctl --user is-active ${name}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      console.log(`  ${name}: ${output}`);
    } catch {
      console.log(`  ${name}: not installed`);
    }
  }
}

// ─── Windows: Scheduled Task ────────────────────────────────────────────────

// ─── Public: Windows AutoStart (shared by service.ts and tunnel.ts) ─────────

/**
 * Install a Windows auto-start entry with full fallback chain:
 * schtasks → UAC → HKCU Run → Startup folder.
 * Returns the method used: 'task' | 'run-key' | 'startup' | null.
 */
export function installWindowsAutoStart(
  name: string,
  command: string,
  ws?: string,
): 'task' | 'run-key' | 'startup' | null {
  const startupDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const workDir = ws || os.homedir();

  const writeBat = () => {
    fs.mkdirSync(startupDir, { recursive: true });
    const batFile = path.join(startupDir, `${name}.bat`);
    fs.writeFileSync(
      batFile,
      `@echo off\r\ncd /d "${workDir}"\r\nstart /B "" ${command}\r\n`,
    );
    return batFile;
  };

  const trySchedTask = (highest = false) => {
    try {
      const rl = highest ? ' /RL HIGHEST' : '';
      const escaped = command.replace(/"/g, '\\"');
      const cmd = `schtasks /Create /TN "${name}" /TR "${escaped}" /SC ONLOGON${rl} /F`;
      execSync(cmd, { stdio: 'pipe' });
      return { ok: true, err: '' };
    } catch (err: any) {
      const msg = ((err.stderr || '') + '\n' + (err.stdout || ''))
        .toString()
        .trim();
      return { ok: false, err: msg || err.message || 'unknown error' };
    }
  };

  // 1. Try schtasks
  let lastErr = '';
  for (const highest of [true, false]) {
    const result = trySchedTask(highest);
    if (result.ok) {
      console.log(`  \u2705 ${name} scheduled task created`);
      return 'task' as const;
    }
    lastErr = result.err;
    console.log(
      `  \u26a0\ufe0f  schtasks failed${highest ? ' (/RL HIGHEST)' : ''}: ${result.err}`,
    );
  }

  // 2. UAC elevation — use a temp script to avoid quote escaping hell
  if (/Access is denied/i.test(lastErr)) {
    try {
      // Write schtasks command to a temp bat file
      const tmpBat = path.join(
        os.tmpdir(),
        `nanoclaw-schtask-${Date.now()}.bat`,
      );
      fs.writeFileSync(
        tmpBat,
        `@echo off\nschtasks /Create /TN "${name}" /TR "${command}" /SC ONLOGON /RL HIGHEST /F\n`,
      );
      // Run the bat file elevated
      const psScript = `Start-Process -FilePath '${tmpBat}' -Verb RunAs -Wait`;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        stdio: 'inherit',
        timeout: 30000,
      });
      // Clean up temp file
      try {
        fs.unlinkSync(tmpBat);
      } catch {
        /* */
      }
      // Verify the task actually exists
      try {
        execSync(`schtasks /Query /TN "${name}" /FO CSV /NH`, {
          stdio: 'pipe',
        });
        console.log(`  \u2705 ${name} scheduled task created via UAC`);
        return 'task' as const;
      } catch {
        console.log(
          `  \u26a0\ufe0f  UAC completed but task not found — may need different task name`,
        );
      }
    } catch (err: any) {
      const msg = ((err.stderr || '') + '\n' + (err.stdout || ''))
        .toString()
        .trim();
      console.log(
        `  \u26a0\ufe0f  Elevated schtasks failed: ${msg || err.message || 'unknown'}`,
      );
    }
  }

  // 3. HKCU Run key
  try {
    const batFile = writeBat();
    execSync(
      `reg add "${runKey}" /v "${name}" /t REG_SZ /d "\"${batFile}\"" /f`,
      { stdio: 'pipe' },
    );
    console.log(`  \u2705 Registered HKCU Run key for ${name}`);
    return 'run-key' as const;
  } catch {
    /* */
  }

  // 4. Startup folder (last resort)
  const batFile = writeBat();
  console.log(`  \u2705 Created startup script: ${batFile}`);
  return 'startup' as const;
}

// ─── Windows: Scheduled Task ──────────────────────────────────────────────────

function installWindows(ws: string, tunnelId?: string): void {
  const nanoclawBin = resolveNanoclawBin();
  const nanoclawCmd = `"${getNodePath()}" "${nanoclawBin}" start --foreground`;

  console.log('  Installing NanoClaw auto-start...');
  installWindowsAutoStart(SERVICE_NAME, nanoclawCmd, ws);

  if (tunnelId) {
    const devtunnelCmd = `devtunnel host ${tunnelId} --allow-anonymous`;
    console.log('  Installing DevTunnel auto-start...');
    installWindowsAutoStart(DEVTUNNEL_SERVICE_NAME, devtunnelCmd, ws);
  }
}

function uninstallWindows(): void {
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const startupDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );

  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      execSync(`schtasks /Delete /TN "${name}" /F`, { stdio: 'pipe' });
      console.log(`  Removed scheduled task: ${name}`);
    } catch {
      /* */
    }
    try {
      execSync(`reg delete "${runKey}" /v "${name}" /f`, { stdio: 'pipe' });
      console.log(`  Removed HKCU Run key: ${name}`);
    } catch {
      /* */
    }

    const batFile = path.join(startupDir, `${name}.bat`);
    const vbsFile = path.join(startupDir, `${name}.vbs`);
    if (fs.existsSync(batFile)) {
      fs.unlinkSync(batFile);
      console.log(`  Removed: ${batFile}`);
    }
    if (fs.existsSync(vbsFile)) {
      fs.unlinkSync(vbsFile);
      console.log(`  Removed: ${vbsFile}`);
    }
  }
  console.log('  ✅ Services uninstalled');
}

function statusWindows(): void {
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const startupDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );

  for (const name of [SERVICE_NAME, DEVTUNNEL_SERVICE_NAME]) {
    try {
      const output = execSync(`schtasks /Query /TN "${name}" /FO CSV /NH`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const status = output.includes('Running')
        ? 'running'
        : output.includes('Ready')
          ? 'ready'
          : 'unknown';
      console.log(`  ${name}: ${status}`);
      continue;
    } catch {
      /* */
    }
    try {
      execSync(`reg query "${runKey}" /v "${name}"`, { stdio: 'pipe' });
      console.log(`  ${name}: run-key`);
      continue;
    } catch {
      /* */
    }
    const batFile = path.join(startupDir, `${name}.bat`);
    const vbsFile = path.join(startupDir, `${name}.vbs`);
    if (fs.existsSync(batFile) || fs.existsSync(vbsFile)) {
      console.log(`  ${name}: startup-folder`);
      continue;
    }
    console.log(`  ${name}: not installed`);
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
      if (platform === 'win32') {
        uninstallWindows();
      } else if (platform === 'linux') {
        uninstallSystemd();
      } else {
        console.log(`  Unsupported platform: ${platform}`);
      }
      break;
    }
    case 'status':
    default: {
      console.log('Service status:');
      if (platform === 'win32') {
        statusWindows();
      } else if (platform === 'linux') {
        statusSystemd();
      } else {
        console.log(`  Unsupported platform: ${platform}`);
      }
      break;
    }
  }
}
