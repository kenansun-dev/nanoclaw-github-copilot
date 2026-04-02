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
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
    console.log(`Current version: ${pkg.version}`);
  } catch {
    /* ignore */
  }

  console.log('🔄 Updating NanoClaw...');
  console.log('');

  try {
    // Stop service if running
    try {
      execSync('nanoclaw stop', { stdio: 'pipe', timeout: 15000 });
      console.log('  Stopped running instance');
    } catch {
      // Not running, fine
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

    // Re-run init to sync workspace (idempotent — won't overwrite config)
    console.log('  Syncing workspace...');
    try {
      execSync('nanoclaw init', { stdio: 'inherit', timeout: 30000 });
    } catch {
      console.log('  ⚠️  Workspace sync had issues. Run: nanoclaw init');
    }

    // Rebuild sandbox image if in sandbox mode
    try {
      const { loadConfig } = await import('../config-loader.js');
      const config = loadConfig();
      if (config.agents?.defaults?.mode !== 'host') {
        console.log('  Rebuilding container image...');
        execSync('nanoclaw sandbox build', {
          stdio: 'inherit',
          timeout: 600000,
        });
      }
    } catch {
      // host mode or config not available
    }

    // Restart service
    console.log('');
    console.log('  Restarting NanoClaw...');
    try {
      execSync('nanoclaw start', { stdio: 'pipe', timeout: 10000 });
      console.log('  ✅ NanoClaw restarted');
    } catch {
      console.log('  ⚠️  Could not auto-restart. Run: nanoclaw start');
    }

    // Show new version
    try {
      const newPkg = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
      );
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
      const tagRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest`,
        { headers: { Accept: 'application/vnd.github.v3+json' } },
      );
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
