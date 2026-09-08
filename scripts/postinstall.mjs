/**
 * postinstall — install agent-runner dependencies and compile TypeScript for global installs.
 * 
 * When installed via `npm install -g`, the agent-runner sub-packages
 * need their own node_modules (copilot-sdk, etc.) and compiled dist/.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyCopilotInstall } from './verify-copilot-install.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const runners = [
  'container/agent-runner-ghc',
  'container/agent-runner',
];

let hadFatal = false;

// The host model catalog uses the root SDK; verify it as well as both runners.
try {
  console.log(`[postinstall] ${verifyCopilotInstall(projectRoot)}`);
} catch (err) {
  console.error(`[postinstall] ❌ ${err.message}`);
  hadFatal = true;
}

for (const runner of runners) {
  const runnerDir = join(projectRoot, runner);
  const pkgJson = join(runnerDir, 'package.json');

  if (!existsSync(pkgJson)) continue;

  try {
    console.log(`[postinstall] Installing deps for ${runner} (timeout 600s)...`);
    execSync('npm install --omit=dev --no-audit --no-fund', {
      cwd: runnerDir,
      stdio: 'inherit',
      timeout: 600_000, // 10min — Windows + slow npm registries can break 2min
    });
  } catch (err) {
    hadFatal = true;
    console.error(`[postinstall] ❌ npm install failed for ${runner}: ${err && err.message}`);
  }

  // Verify exact SDK + host-native runtime even when npm reported success.
  // A missing optional platform package is fatal; the standalone CLI cannot
  // substitute for the SDK 1.0.13 runtime bundle.
  try {
    console.log(`[postinstall] ${verifyCopilotInstall(runnerDir)}`);
  } catch (err) {
    console.error(`[postinstall] ❌ ${runner}: ${err.message}`);
    hadFatal = true;
  }

  // Compile TypeScript if tsconfig.json exists. Compile failures are not
  // fatal — published tarball ships pre-built dist/.
  const tsconfigPath = join(runnerDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    try {
      console.log(`[postinstall] Compiling ${runner}...`);
      execSync('npx tsc', {
        cwd: runnerDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      console.log(`[postinstall] Skipped ${runner} compilation (may already be compiled)`);
    }
  }
}

if (hadFatal) {
  console.error('');
  console.error('\x1b[31m❌ NanoClaw install incomplete — SDK/runtime dependency installation failed.\x1b[0m');
  console.error('   Fix: run `npm install --include=optional` in the package root and each affected runner under container/.');
  console.error('');
  process.exit(1);
}

console.log('');
console.log('\x1b[32m\u2705 NanoClaw installed!\x1b[0m');
console.log('');
console.log('  Get started:  nanoclaw init');
console.log('  Help:         nanoclaw --help');
console.log('');
