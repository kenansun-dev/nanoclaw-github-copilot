/**
 * postinstall — install agent-runner dependencies for global installs.
 * 
 * When installed via `npm install -g`, the agent-runner sub-packages
 * need their own node_modules (copilot-sdk, etc.).
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const runners = [
  'container/agent-runner-ghc',
  'container/agent-runner',
];

for (const runner of runners) {
  const runnerDir = join(projectRoot, runner);
  const pkgJson = join(runnerDir, 'package.json');
  
  if (existsSync(pkgJson)) {
    // Always try install — node_modules may exist but be incomplete from npm pack
    try {
      console.log(`[postinstall] Installing deps for ${runner}...`);
      execSync('npm install --omit=dev --no-audit --no-fund', {
        cwd: runnerDir,
        stdio: 'pipe',
        timeout: 120000,
      });
    } catch (err) {
      // Best effort — dev mode doesn't need this
      console.log(`[postinstall] Skipped ${runner} (deps may already be available)`);
    }
  }
}
