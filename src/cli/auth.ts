/**
 * nanoclaw auth — GitHub Copilot authentication
 *
 * Uses the GHC CLI's built-in OAuth device code flow.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWorkspace } from '../workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Find the GHC CLI binary (copilot or ghcs)
 */
function findCopilotCli(): string | null {
  // Check in agent-runner-ghc node_modules
  const localBin = path.join(
    PROJECT_ROOT,
    'container',
    'agent-runner-ghc',
    'node_modules',
    '.bin',
    'copilot',
  );
  const localBinCmd = localBin + (process.platform === 'win32' ? '.cmd' : '');
  if (fs.existsSync(localBinCmd)) return localBinCmd;
  if (fs.existsSync(localBin)) return localBin;

  // Check global
  try {
    const cmd =
      process.platform === 'win32' ? 'where copilot' : 'which copilot';
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim()
      .split('\n')[0];
  } catch {
    /* */
  }

  try {
    const cmd = process.platform === 'win32' ? 'where ghcs' : 'which ghcs';
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim()
      .split('\n')[0];
  } catch {
    /* */
  }

  return null;
}

/**
 * Check if already authenticated
 */
function isAuthenticated(): boolean {
  // Check env var
  if (
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  ) {
    return true;
  }

  // Check .env file
  const ws = resolveWorkspace();
  const envFile = path.join(ws, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    if (
      content.includes('COPILOT_GITHUB_TOKEN=') &&
      !content.includes('COPILOT_GITHUB_TOKEN=\n')
    ) {
      return true;
    }
  }

  // Check OpenClaw auth profile
  try {
    const profilePath = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.openclaw',
      'agents',
      'main',
      'agent',
      'auth-profiles.json',
    );
    if (fs.existsSync(profilePath)) {
      const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      for (const profile of Object.values(profiles.profiles || {})) {
        const p = profile as { provider?: string; token?: string };
        if (p.provider === 'github-copilot' && p.token) return true;
      }
    }
  } catch {
    /* */
  }

  return false;
}

export async function runAuth(args: string[]): Promise<void> {
  const subcommand = args[0] || 'status';

  switch (subcommand) {
    case 'login': {
      if (isAuthenticated()) {
        console.log('✅ Already authenticated.');
        console.log(
          '   To re-authenticate, run: nanoclaw auth logout && nanoclaw auth login',
        );
        return;
      }

      const cli = findCopilotCli();
      if (!cli) {
        console.error('❌ GitHub Copilot CLI not found.');
        console.error('   Install: npm install -g @github/copilot');
        console.error('   Or set COPILOT_GITHUB_TOKEN in ~/.nanoclaw/.env');
        process.exit(1);
      }

      console.log('🔑 Starting GitHub Copilot authentication...');
      console.log('   A browser window will open for you to authorize.');
      console.log('');

      // Run copilot auth login — this handles the device code flow
      const result = spawnSync(cli, ['auth', 'login'], {
        stdio: 'inherit',
        env: { ...process.env },
      });

      if (result.status === 0) {
        console.log('');
        console.log('✅ Authentication successful!');
        console.log('   Token stored by GitHub Copilot CLI.');
      } else {
        console.error('');
        console.error('❌ Authentication failed.');
        console.error(
          '   Alternative: set COPILOT_GITHUB_TOKEN=ghu_xxx in ~/.nanoclaw/.env',
        );
        process.exit(1);
      }
      break;
    }

    case 'logout': {
      const cli = findCopilotCli();
      if (cli) {
        spawnSync(cli, ['auth', 'logout'], { stdio: 'inherit' });
      }
      console.log('Logged out.');
      break;
    }

    case 'status':
    default: {
      if (isAuthenticated()) {
        console.log('✅ Authenticated');
        // Show which method
        if (process.env.COPILOT_GITHUB_TOKEN) {
          console.log('   Method: COPILOT_GITHUB_TOKEN env var');
        } else {
          const ws = resolveWorkspace();
          const envFile = path.join(ws, '.env');
          if (
            fs.existsSync(envFile) &&
            fs.readFileSync(envFile, 'utf-8').includes('COPILOT_GITHUB_TOKEN=')
          ) {
            console.log('   Method: ~/.nanoclaw/.env');
          } else {
            console.log('   Method: OpenClaw auth profile or GHC CLI');
          }
        }
      } else {
        console.log('❌ Not authenticated');
        console.log('   Run: nanoclaw auth login');
      }
      break;
    }
  }
}
