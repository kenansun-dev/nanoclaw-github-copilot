/**
 * nanoclaw pair — register a new chat
 */
import readline from 'readline';
import { loadConfig, saveConfig } from '../config-loader.js';
import { getDb } from '../db/connection.js';
import { redeemPairingCode, listPendingPairings, revokePairingCode } from '../v2-access.js';

/**
 * Tiny inline column formatter — avoids pulling in cli-table just for
 * the `pair pending` table. Pads each cell to the widest cell in its
 * column with two spaces of gap.
 */
function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (cells: string[]): string => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [pad(headers), ...rows.map(pad)].join('\n');
}

function humanizeExpires(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return iso;
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `in ${h}h`;
  const m = Math.max(1, Math.floor(ms / 60_000));
  return `in ${m}m`;
}

export async function runPair(args: string[]): Promise<void> {
  // Subcommands first (`nanoclaw pair approve <code>`, `nanoclaw pair pending`).
  // Falls through to the legacy direct/interactive flow when the first arg
  // is not a recognized subcommand.
  const sub = args[0];
  if (sub === 'approve') {
    const rawCode = args[1];
    if (!rawCode) {
      console.error('Usage: nanoclaw pair approve <CODE> [--owner <id>] [--agent <agent-group-id>]');
      process.exit(1);
    }
    let ownerId: string | null = null;
    let agentId: string | null = null;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--owner' && args[i + 1]) ownerId = args[++i];
      else if (args[i] === '--agent' && args[i + 1]) agentId = args[++i];
    }
    if (!ownerId) {
      // Default: use the first owner row in user_roles. Operators running
      // this from a shell are presumed to *be* the owner; pick the row
      // so the granted_by FK is satisfiable.
      try {
        const db = getDb();
        const row = db.prepare(`SELECT user_id FROM user_roles WHERE role = 'owner' LIMIT 1`).get() as
          | { user_id: string }
          | undefined;
        if (row) ownerId = row.user_id;
      } catch {
        /* fall through to error below */
      }
    }
    if (!ownerId) {
      console.error('No global owner found. Pass --owner <user-id> explicitly, or run nanoclaw init first.');
      process.exit(1);
    }
    const db = getDb();
    const result = redeemPairingCode(db, rawCode, ownerId, agentId);
    if (!result.ok) {
      console.error(`❌ Pairing failed: ${result.error ?? 'unknown'}`);
      process.exit(1);
    }
    const n = result.replayed?.length ?? 0;
    console.log(
      `✅ Paired ${result.channelType}/${result.accountKey} peer=${result.peerId} — ${n} held message${n === 1 ? '' : 's'} ready to dispatch.`,
    );
    return;
  }
  if (sub === 'pending' || sub === 'list-pending') {
    // Local-shell command: if at least one owner row exists, the
    // invoker is presumed to be that owner (terminal access == operator).
    const db = getDb();
    const rows = listPendingPairings(db);
    if (rows.length === 0) {
      console.log('No pending pairing codes.');
      return;
    }
    const table = formatTable(
      ['CODE', 'PEER', 'CHANNEL', 'MSGS', 'EXPIRES'],
      rows.map((r) => [
        `${r.code.slice(0, 4)}-${r.code.slice(4)}`,
        r.peerId,
        `${r.channelType}/${r.accountKey}`,
        String(r.messageCount),
        humanizeExpires(r.expiresAt),
      ]),
    );
    console.log(table);
    return;
  }
  if (sub === 'revoke') {
    const rawCode = args[1];
    if (!rawCode) {
      console.error('Usage: nanoclaw pair revoke <CODE>');
      process.exit(1);
    }
    const db = getDb();
    const result = revokePairingCode(db, rawCode);
    if (!result.ok) {
      console.error(`❌ Revoke failed: ${result.error ?? 'unknown'}`);
      process.exit(1);
    }
    console.log(
      `✅ Revoked ${result.channelType}/${result.accountKey} peer=${result.peerId} — removed ${result.removed ?? 0} held message${result.removed === 1 ? '' : 's'}.`,
    );
    return;
  }

  const config = loadConfig();

  // Direct mode: nanoclaw pair <jid> --name <name> [--main]
  if (args.length > 0 && !args[0].startsWith('-')) {
    const jid = args[0];
    let name = '';
    let isMain = true;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--name' && args[i + 1]) {
        name = args[++i];
      } else if (args[i] === '--main') {
        isMain = true;
      } else if (args[i] === '--no-main') {
        isMain = false;
      }
    }
    if (!name) {
      // Generate a readable short name from the JID
      const prefix = jid.split(':')[0] || 'chat';
      name = `${prefix}-chat`;
    }

    const channel = jid.startsWith('tg:') ? 'telegram' : jid.startsWith('teams:') ? 'teams' : 'unknown';

    if (!config.chats) (config as any).chats = {};
    (config.chats as any)[jid] = { name, ...(isMain ? { isMain: true } : {}) };
    saveConfig(config);

    console.log(`✅ Paired: ${jid}`);
    console.log(`   Name: ${name}`);
    console.log(`   Channel: ${channel}`);
    console.log(`   Main: ${isMain}`);
    console.log(`\nRestart nanoclaw to activate: nanoclaw restart`);
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log('NanoClaw — Pair a new chat\n');
  const jid = await ask('Chat JID (e.g. tg:123456 or teams:abc): ');
  const name = await ask('Name for this chat: ');
  const mainAnswer = await ask('Is this the main chat? (Y/n): ');
  const isMain = mainAnswer.toLowerCase() !== 'n';
  rl.close();

  if (!jid) {
    console.error('Error: JID is required.');
    process.exit(1);
  }

  if (!config.chats) (config as any).chats = {};
  (config.chats as any)[jid] = {
    name: name || jid,
    ...(isMain ? { isMain: true } : {}),
  };
  saveConfig(config);

  console.log(`\n✅ Paired: ${jid}`);
  console.log(`\nRestart nanoclaw to activate: nanoclaw restart`);
}
