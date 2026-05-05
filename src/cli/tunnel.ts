/**
 * nanoclaw tunnel — DevTunnel setup for Teams webhook endpoint.
 *
 * Automates:
 *  1. Check devtunnel CLI installed
 *  2. Check login status
 *  3. Find or create a tunnel with description "nanoclaw"
 *  4. Add port 3978 (http, not https)
 *  5. Add anonymous access
 *  6. Install systemd service or scheduled task for persistence
 *  7. Print the tunnel URL
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const TUNNEL_DESCRIPTION = 'nanoclaw';
const TUNNEL_PORT = 3978;

function run(cmd: string, opts?: { silent?: boolean }): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
    return { ok: true, output };
  } catch (err: any) {
    const output = (err.stdout || '').toString().trim() + '\n' + (err.stderr || '').toString().trim();
    if (!opts?.silent) {
      // swallow
    }
    return { ok: false, output: output.trim() };
  }
}

export async function runTunnel(args: string[]): Promise<void> {
  const sub = args[0] || 'setup';

  if (sub === 'setup') {
    await setupTeamsTunnel();
  } else if (sub === 'status') {
    await tunnelStatus();
  } else if (sub === 'url') {
    await tunnelUrl();
  } else {
    console.log(`Usage: nanoclaw tunnel <setup|status|url>`);
    console.log('');
    console.log('Commands:');
    console.log('  setup     Set up a dev tunnel for Teams webhook (port 3978)');
    console.log('  status    Show tunnel status');
    console.log('  url       Print the tunnel URL for Azure Bot endpoint config');
  }
}

export async function setupTeamsTunnel(): Promise<void> {
  console.log('🔧 NanoClaw DevTunnel Setup\n');

  // 1. Check devtunnel CLI
  console.log('1. Checking devtunnel CLI...');
  const devtunnelCheck = run('devtunnel --version');
  if (!devtunnelCheck.ok) {
    console.error('   ❌ devtunnel CLI not found.');
    console.error('   Install: https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started');
    console.error('   Or: curl -sL https://aka.ms/DevTunnelCliInstall | bash');
    process.exit(1);
  }
  console.log(`   ✅ ${devtunnelCheck.output}`);

  // 2. Check login
  console.log('\n2. Checking login status...');
  const userCheck = run('devtunnel user show');
  if (!userCheck.ok || userCheck.output.includes('not logged in')) {
    console.error('   ❌ Not logged in to devtunnel.');
    console.error('   Run: devtunnel user login');
    process.exit(1);
  }
  console.log(`   ✅ Logged in`);

  // 3. Find or create tunnel
  console.log('\n3. Looking for existing nanoclaw tunnel...');
  let tunnelId = findNanoclawTunnel();

  if (tunnelId) {
    console.log(`   ✅ Found existing tunnel: ${tunnelId}`);
  } else {
    console.log('   Creating new tunnel...');
    const createResult = run(`devtunnel create --description "${TUNNEL_DESCRIPTION}"`);
    if (!createResult.ok) {
      console.error(`   ❌ Failed to create tunnel: ${createResult.output}`);
      process.exit(1);
    }
    tunnelId = parseTunnelId(createResult.output);
    if (!tunnelId) {
      console.error(`   ❌ Could not parse tunnel ID from output: ${createResult.output}`);
      process.exit(1);
    }
    console.log(`   ✅ Created tunnel: ${tunnelId}`);
  }

  // 4. Add port 3978
  console.log(`\n4. Adding port ${TUNNEL_PORT}...`);
  const portResult = run(`devtunnel port create ${tunnelId} -p ${TUNNEL_PORT} --protocol http`);
  if (portResult.ok) {
    console.log(`   ✅ Port ${TUNNEL_PORT} added (protocol: http)`);
  } else if (portResult.output.includes('already exists')) {
    console.log(`   ✅ Port ${TUNNEL_PORT} already configured`);
  } else {
    console.error(`   ⚠️  Port setup issue (may already exist): ${portResult.output}`);
  }

  // 5. Add anonymous access
  console.log('\n5. Setting anonymous access...');
  const accessResult = run(`devtunnel access create ${tunnelId} -p ${TUNNEL_PORT} --anonymous`);
  if (accessResult.ok) {
    console.log('   ✅ Anonymous access enabled');
  } else if (accessResult.output.includes('already exists')) {
    console.log('   ✅ Anonymous access already configured');
  } else {
    console.error(`   ⚠️  Access setup issue (may already exist): ${accessResult.output}`);
  }

  // 6. No auto-persistence — user starts manually
  console.log('\n6. Tunnel ready. Start manually:');
  console.log(`   devtunnel host ${tunnelId} --allow-anonymous`);

  // 7. Register addon
  console.log('\n7. Registering addon...');
  const url = getTunnelUrl(tunnelId);
  try {
    const { registerAddon } = await import('./addon.js');
    registerAddon('teams-tunnel', {
      type: 'devtunnel',
      channel: 'teams',
      enabled: true,
      config: {
        tunnelId,
        port: TUNNEL_PORT,
        url: url ? `${url}/api/messages` : undefined,
        taskName: 'NanoClaw-DevTunnel',
      },
    });
    console.log('   ✅ Addon registered');
  } catch {
    /* best effort */
  }

  // 8. Print URL
  console.log('\n8. Tunnel URL:');
  if (url) {
    console.log(`\n   🌐 ${url}/api/messages`);
    console.log('\n   Use this as the Messaging endpoint in Azure Bot configuration.');
  } else {
    console.log('   ⚠️  Could not determine tunnel URL. Run: devtunnel show ' + tunnelId);
  }

  console.log('\n✅ DevTunnel setup complete!');
}

async function tunnelStatus(): Promise<void> {
  const tunnelId = findNanoclawTunnel();
  if (!tunnelId) {
    console.log('No nanoclaw tunnel found. Run: nanoclaw tunnel setup');
    return;
  }
  console.log(`Tunnel: ${tunnelId}`);
  const showResult = run(`devtunnel show ${tunnelId}`);
  if (showResult.ok) {
    console.log(showResult.output);
  }
}

async function tunnelUrl(): Promise<void> {
  const tunnelId = findNanoclawTunnel();
  if (!tunnelId) {
    console.log('No nanoclaw tunnel found. Run: nanoclaw tunnel setup');
    return;
  }
  const url = getTunnelUrl(tunnelId);
  if (url) {
    console.log(`${url}/api/messages`);
  } else {
    console.log('Could not determine tunnel URL.');
  }
}

// --- Helpers ---

function findNanoclawTunnel(): string | null {
  const listResult = run('devtunnel list');
  if (!listResult.ok) return null;

  // Look for a tunnel with "nanoclaw" in description
  for (const line of listResult.output.split('\n')) {
    if (line.toLowerCase().includes(TUNNEL_DESCRIPTION)) {
      const match = line.match(/([a-zA-Z0-9._-]+)/);
      if (match) return match[1];
    }
  }
  return null;
}

function parseTunnelId(output: string): string | null {
  // devtunnel create output typically contains the tunnel ID
  const match = output.match(/Tunnel ID[:\s]+([a-zA-Z0-9._-]+)|(?:^|\s)([a-zA-Z0-9]+-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)/m);
  if (match) return match[1] || match[2];

  // Try first word that looks like a tunnel ID
  const idMatch = output.match(/([a-zA-Z0-9]+-[a-zA-Z0-9]+)/);
  return idMatch ? idMatch[1] : null;
}

function getTunnelUrl(tunnelId: string): string | null {
  const showResult = run(`devtunnel show ${tunnelId}`);
  if (!showResult.ok) return null;

  // Look for URL in output
  const urlMatch = showResult.output.match(/https?:\/\/[a-zA-Z0-9._-]+\.devtunnels\.ms[^\s]*/);
  if (urlMatch) return urlMatch[0].replace(/\/+$/, '');

  // Try port show
  const portResult = run(`devtunnel port show ${tunnelId} -p ${TUNNEL_PORT}`);
  if (portResult.ok) {
    const portUrl = portResult.output.match(/https?:\/\/[a-zA-Z0-9._-]+\.devtunnels\.ms[^\s]*/);
    if (portUrl) return portUrl[0].replace(/\/+$/, '');
  }

  return null;
}
