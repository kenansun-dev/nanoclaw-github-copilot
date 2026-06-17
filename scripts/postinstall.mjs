/**
 * postinstall — install agent-runner dependencies and compile TypeScript for global installs.
 * 
 * When installed via `npm install -g`, the agent-runner sub-packages
 * need their own node_modules (copilot-sdk, etc.) and compiled dist/.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const runners = [
  'container/agent-runner-ghc',
  'container/agent-runner',
];

// Required nested SDK version. If postinstall fails to install runner deps
// AND the nested copy is missing/older, the runner will fall back to the
// top-level @github/copilot-sdk via npm hoist; that fallback MUST match the
// CLI's major.minor or the CLI throws `unexpected user permission response`
// at runtime. SDK 1.0.x pairs with @github/copilot ^1.0.61 (CLI 1.0.63 here).
// We bumped top-level + both runner deps to ^1.0.1 in package.json as belt;
// this check is suspenders.
const REQUIRED_SDK_MAJOR_MINOR = '1.0';

function sdkVersion(runnerDir) {
  const p = join(runnerDir, 'node_modules', '@github', 'copilot-sdk', 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
}

let hadFatal = false;

for (const runner of runners) {
  const runnerDir = join(projectRoot, runner);
  const pkgJson = join(runnerDir, 'package.json');

  if (!existsSync(pkgJson)) continue;

  let installFailed = false;
  try {
    console.log(`[postinstall] Installing deps for ${runner} (timeout 600s)...`);
    execSync('npm install --omit=dev --no-audit --no-fund', {
      cwd: runnerDir,
      stdio: 'inherit',
      timeout: 600_000, // 10min — Windows + slow npm registries can break 2min
    });
  } catch (err) {
    installFailed = true;
    console.error(`[postinstall] ❌ npm install failed for ${runner}: ${err && err.message}`);
  }

  // Verify SDK version regardless of install outcome (nested copy may have
  // been left over from a prior install).
  const v = sdkVersion(runnerDir);
  if (!v) {
    console.error(`[postinstall] ❌ ${runner}: @github/copilot-sdk not found under node_modules.`);
    hadFatal = true;
  } else if (!v.startsWith(`${REQUIRED_SDK_MAJOR_MINOR}.`)) {
    console.error(
      `[postinstall] ❌ ${runner}: @github/copilot-sdk@${v}, requires ${REQUIRED_SDK_MAJOR_MINOR}.x ` +
      '(CLI 1.0.3x rejects older approveAll shape with "unexpected user permission response")',
    );
    hadFatal = true;
  } else {
    console.log(`[postinstall] ✅ ${runner}: @github/copilot-sdk@${v}`);
  }
  if (installFailed && hadFatal) {
    // Already logged.
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
  console.error('\x1b[31m❌ NanoClaw install incomplete — agent runner SDK missing or wrong version.\x1b[0m');
  console.error('   Fix: cd into each runner under container/ and run `npm install --omit=dev`.');
  console.error('');
  process.exit(1);
}

console.log('');
console.log('\x1b[32m\u2705 NanoClaw installed!\x1b[0m');
console.log('');
console.log('  Get started:  nanoclaw init');
console.log('  Help:         nanoclaw --help');
console.log('');
