/**
 * nanoclaw pair — register a new chat
 */
import readline from 'readline';
import { loadConfig, saveConfig } from '../config-loader.js';

export async function runPair(args: string[]): Promise<void> {
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
