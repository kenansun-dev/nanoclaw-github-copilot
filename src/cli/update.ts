/**
 * nanoclaw update — update nanoclaw to latest version
 *
 * Supports:
 *   nanoclaw update                    — from npm registry
 *   nanoclaw update --package <tgz>   — from local tgz file
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_NAME = 'nanoclaw-github-copilot';

export async function runUpdate(args: string[]): Promise<void> {
  // Parse --package flag
  let packagePath: string | null = null;
  const pkgIdx = args.indexOf('--package');
  if (pkgIdx !== -1 && args[pkgIdx + 1]) {
    packagePath = args[pkgIdx + 1];
  }

  console.log('🔄 Updating NanoClaw...');
  console.log('');

  try {
    // Stop service if running
    try {
      execSync('nanoclaw stop', { stdio: 'pipe', timeout: 10000 });
      console.log('  Stopped running instance');
    } catch {
      // Not running, fine
    }

    // Install
    if (packagePath) {
      const resolved = path.resolve(packagePath);
      console.log(`  Installing from: ${resolved}`);
      execSync(`npm install -g "${resolved}"`, {
        stdio: 'inherit',
        timeout: 120000,
      });
    } else {
      console.log(`  Installing latest from npm...`);
      execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
        stdio: 'inherit',
        timeout: 120000,
      });
    }

    console.log('');

    // Re-run init to sync workspace (idempotent — won't overwrite config)
    console.log('  Syncing workspace...');
    try {
      execSync('nanoclaw init', { stdio: 'inherit', timeout: 30000 });
    } catch {
      console.log('  ⚠️  Workspace sync had issues. Run: nanoclaw init');
    }

    console.log('');
    console.log('✅ Update complete!');
    console.log('');
    console.log('Next steps:');
    console.log('  nanoclaw doctor    — check everything is ready');
    console.log('  nanoclaw start     — start the service');
  } catch (err: any) {
    console.error('❌ Update failed:', err.message || err);
    process.exit(1);
  }
}
