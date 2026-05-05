/**
 * nanoclaw update — update nanoclaw to latest version
 *
 * Sources (in priority order):
 *   nanoclaw update --package <tgz>    — from local tgz file
 *   nanoclaw update --source github    — from GitHub Release (latest tag)
 *   nanoclaw update --source npm       — from npm registry
 *   nanoclaw update                    — auto: try npm first, fall back to GitHub
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_NAME = 'nanoclaw-github-copilot';
const GITHUB_REPO = 'kenans/nanoclaw-github-copilot';

/**
 * Wait for a PID to exit, with force kill fallback.
 * Returns when the process is gone or timeout is reached.
 */
async function waitForProcessExit(pid: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // Check if process exists
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      return; // Process is gone
    }
  }
  // Timeout: force kill
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    /* already dead */
  }
}

export async function runUpdate(args: string[]): Promise<void> {
  // Parse flags
  let packagePath: string | null = null;
  let source: 'npm' | 'github' | 'auto' = 'auto';

  const pkgIdx = args.indexOf('--package');
  if (pkgIdx !== -1 && args[pkgIdx + 1]) {
    packagePath = args[pkgIdx + 1];
  }
  const srcIdx = args.indexOf('--source');
  if (srcIdx !== -1 && args[srcIdx + 1]) {
    const s = args[srcIdx + 1].toLowerCase();
    if (s === 'npm' || s === 'github') source = s;
  }

  // Show current version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    console.log(`Current version: ${pkg.version}`);
  } catch {
    /* ignore */
  }

  console.log('🔄 Updating NanoClaw...');
  console.log('');

  try {
    // Stop service if running
    try {
      // Read PID before stopping so we can wait for exit
      let runningPid: number | undefined;
      try {
        const { resolveWorkspace } = await import('../workspace.js');
        const ws = resolveWorkspace();
        const pidFile = path.join(ws, 'state', 'nanoclaw.pid');
        if (fs.existsSync(pidFile)) {
          runningPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        }
      } catch {
        /* */
      }

      execSync('nanoclaw stop', { stdio: 'inherit', timeout: 15000 });
      console.log('  Stopped running instance');

      // Wait for process to fully release file locks (important on Windows)
      if (runningPid && !isNaN(runningPid)) {
        process.stdout.write('  Waiting for process to exit...');
        await waitForProcessExit(runningPid, 8000);
        console.log(' done');
      } else {
        // No PID file — wait a fixed time for safety
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err: any) {
      // Not running is fine; surface other errors so they aren't silently lost.
      const msg = String(err?.message ?? err);
      if (!/Not running/i.test(msg)) {
        console.log(`  (stop reported: ${msg})`);
      }
    }

    // Determine install source
    if (packagePath) {
      // Local tgz
      const resolved = path.resolve(packagePath);
      if (!fs.existsSync(resolved)) {
        console.error(`❌ Package not found: ${resolved}`);
        process.exit(1);
      }
      console.log(`  Installing from: ${resolved}`);
      execSync(`npm install -g "${resolved}"`, {
        stdio: 'inherit',
        timeout: 120000,
      });
    } else if (source === 'github' || source === 'auto') {
      // Try GitHub Release first (or exclusively if --source github)
      const installed = await installFromGitHub();
      if (!installed) {
        if (source === 'github') {
          console.error('❌ GitHub Release download failed.');
          process.exit(1);
        }
        // auto: fall back to npm
        console.log('  GitHub Release not available, trying npm...');
        installFromNpm();
      }
    } else {
      // npm only
      installFromNpm();
    }

    console.log('');

    // v1 → v2 in-place workspace migration. No-op if workspace already on v2
    // schema or if no workspace exists yet (fresh install).
    try {
      const { runV1Migration } = await import('./migrate-v1.js');
      const { resolveWorkspace } = await import('../workspace.js');
      const ws = resolveWorkspace();
      if (fs.existsSync(ws)) {
        const result = runV1Migration(ws, PROJECT_ROOT);
        if (result.status === 'failed') {
          console.error('');
          console.error(`❌ v1 migration failed: ${result.message}`);
          if (result.backupDir) {
            console.error(`   Backup retained at: ${result.backupDir}`);
          }
          console.error('   Aborting update; service NOT restarted.');
          process.exit(1);
        }
      }
    } catch (err: any) {
      console.error(`❌ Migration step crashed: ${err?.message ?? err}`);
      process.exit(1);
    }

    // Re-run init in --sync mode to refresh templates / agent-runner deps
    // without re-prompting Telegram/Teams/auth (those were configured on
    // first install; `update` is a re-install, not first-time setup).
    console.log('  Syncing workspace...');
    try {
      execSync('nanoclaw init --sync', { stdio: 'inherit', timeout: 30000 });
    } catch (err: any) {
      console.log(`  ⚠️  Workspace sync had issues: ${err?.message ?? err}. Run: nanoclaw init --sync`);
    }

    // Rebuild sandbox image if any agent uses sandbox mode
    try {
      const { loadConfig } = await import('../config-loader.js');
      const config = loadConfig();
      const needsContainers =
        config.agents?.list?.some((a: any) => a.mode === 'sandbox') || config.agents?.defaults?.mode !== 'host';
      if (needsContainers) {
        console.log('  Rebuilding container image...');
        execSync('nanoclaw sandbox build', {
          stdio: 'inherit',
          timeout: 600000,
        });
      }

      // Clear agent-runner source cache — forces fresh copy on next container spawn
      const { resolveWorkspace: rw2 } = await import('../workspace.js');
      const sessionsDir = path.join(rw2(), 'data', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const dir of fs.readdirSync(sessionsDir)) {
          const cacheDir = path.join(sessionsDir, dir, 'agent-runner-src');
          if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
          }
          // Clear cached skill copies so agent picks up latest from package
          for (const skillsCache of ['.copilot/skills', '.claude/skills']) {
            const skillDir = path.join(sessionsDir, dir, skillsCache);
            if (fs.existsSync(skillDir)) {
              fs.rmSync(skillDir, { recursive: true, force: true });
            }
          }
        }
        console.log('  Cleared agent-runner and skills cache');
      }
    } catch {
      // config not available or no sandbox agents
    }

    // Restart service
    console.log('');
    console.log('  Restarting NanoClaw...');
    try {
      // Use 'inherit' so the user sees WHY start fails (silent 'pipe' was
      // hiding errors and producing the unhelpful 'Could not auto-restart'
      // message kenan kept hitting on Windows). Bumped timeout from 10s to
      // 30s because Windows `startDirect` waits 3s + log scan + some MSDefender
      // realtime-scan overhead can push past 10s on first start.
      execSync('nanoclaw start', { stdio: 'inherit', timeout: 30000 });
      console.log('  ✅ NanoClaw restarted');
    } catch (err: any) {
      console.log(`  ⚠️  Could not auto-restart: ${err?.message ?? err}. Run: nanoclaw start`);
    }

    // Show new version
    try {
      const newPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
      console.log('');
      console.log(`✅ Updated to ${newPkg.version}`);
    } catch {
      console.log('');
      console.log('✅ Update complete!');
    }
  } catch (err: any) {
    console.error('❌ Update failed:', err.message || err);
    process.exit(1);
  }
}

/**
 * Download and install from GitHub Release (latest tag).
 * Returns true if successful, false if unavailable.
 */
async function installFromGitHub(): Promise<boolean> {
  console.log('  Checking GitHub Release...');
  try {
    const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const res = await fetch(releaseUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) {
      // Try the "latest" tag if no release marked as latest
      const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!tagRes.ok) return false;
      const release = (await tagRes.json()) as any;
      return await downloadAndInstall(release);
    }
    const release = (await res.json()) as any;
    return await downloadAndInstall(release);
  } catch {
    return false;
  }
}

async function downloadAndInstall(release: any): Promise<boolean> {
  const asset = release.assets?.find((a: any) => a.name?.endsWith('.tgz'));
  if (!asset) {
    console.log('  No .tgz asset in release');
    return false;
  }

  console.log(`  Downloading ${asset.name} (${release.tag_name})...`);
  const tgzPath = path.join(os.tmpdir(), asset.name);
  const dlRes = await fetch(asset.browser_download_url);
  if (!dlRes.ok) return false;

  const buffer = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(tgzPath, buffer);

  console.log(`  Installing from GitHub Release...`);
  execSync(`npm install -g "${tgzPath}"`, {
    stdio: 'inherit',
    timeout: 120000,
  });

  // Cleanup temp file
  try {
    fs.unlinkSync(tgzPath);
  } catch {
    /* ignore */
  }
  return true;
}

function installFromNpm(): void {
  console.log(`  Installing from npm registry...`);
  execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
    stdio: 'inherit',
    timeout: 120000,
  });
}
