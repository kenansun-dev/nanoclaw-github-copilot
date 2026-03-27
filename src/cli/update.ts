/**
 * nanoclaw update — self-update to latest version
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_NAME = 'nanoclaw-github-copilot';

interface UpdateResult {
  currentVersion: string;
  latestVersion: string;
  updated: boolean;
  message: string;
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, '..', '..', 'package.json');

  let currentVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    currentVersion = pkg.version;
  } catch {
    // fallback
  }

  let latestVersion = 'unknown';
  try {
    latestVersion = execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch {
    return {
      currentVersion,
      latestVersion: 'unknown',
      updated: false,
      message:
        'Could not check for updates. Are you connected to the internet?',
    };
  }

  if (currentVersion === latestVersion) {
    return {
      currentVersion,
      latestVersion,
      updated: false,
      message: `Already up to date (v${currentVersion}).`,
    };
  }

  return {
    currentVersion,
    latestVersion,
    updated: false,
    message: `Update available: v${currentVersion} → v${latestVersion}`,
  };
}

export async function runUpdate(): Promise<void> {
  const check = await checkForUpdate();
  console.log(check.message);

  if (check.latestVersion === 'unknown') {
    return;
  }

  if (check.currentVersion === check.latestVersion) {
    return;
  }

  console.log(`Updating ${PACKAGE_NAME}...`);

  try {
    execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log(`\n✅ Updated to v${check.latestVersion}`);
    console.log('Run "nanoclaw restart" to apply the update.');
  } catch (err: any) {
    console.error(`\n❌ Update failed: ${err.message}`);
    console.error(`Try manually: npm install -g ${PACKAGE_NAME}@latest`);
  }
}
