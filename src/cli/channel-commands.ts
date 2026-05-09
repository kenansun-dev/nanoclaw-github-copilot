/**
 * nanoclaw channel list/test — channel management CLI
 */

import { loadConfig } from '../config-loader.js';

export function channelList(): void {
  const config = loadConfig();
  const channels = config.channels;

  console.log('Configured channels:\n');

  for (const [name, ch] of Object.entries(channels)) {
    if (typeof ch !== 'object' || ch === null) continue;
    const enabled = (ch as any).enabled;
    const status = enabled ? '✅ enabled' : '⚪ disabled';
    console.log(`  ${name}: ${status}`);

    // Show extra info per channel
    if (name === 'telegram' && enabled) {
      const hasToken = !!(ch as any).botToken || !!process.env.TELEGRAM_BOT_TOKEN;
      console.log(`    Token: ${hasToken ? 'configured' : '❌ missing'}`);
    }
    if (name === 'teams' && enabled) {
      const hasAppId = !!(ch as any).appId || !!process.env.MSTEAMS_APP_ID;
      const hasAuth = !!(ch as any).appPassword || !!process.env.MSTEAMS_APP_PASSWORD;
      const tenantId = (ch as any).tenantId || process.env.MSTEAMS_TENANT_ID || 'common';
      const port = (ch as any).webhookPort || 3978;
      console.log(`    App ID: ${hasAppId ? 'configured' : '❌ missing'}`);
      console.log(`    Auth: ${hasAuth ? 'configured' : '❌ missing'}`);
      console.log(`    Tenant: ${tenantId}`);
      console.log(`    Webhook port: ${port}`);
    }
  }
  console.log('');
}

export async function channelTest(name: string): Promise<void> {
  const config = loadConfig();
  const channel = (config.channels as any)[name];

  if (!channel) {
    console.error(`Unknown channel: ${name}`);
    console.log('Available:', Object.keys(config.channels).join(', '));
    return;
  }

  if (!channel.enabled) {
    console.log(`Channel "${name}" is disabled. Enable it in nanoclaw.json first.`);
    return;
  }

  console.log(`Testing ${name} channel...`);

  if (name === 'telegram') {
    const token = channel.botToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.log('❌ No bot token configured');
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = (await res.json()) as any;
      if (data.ok) {
        console.log(`✅ Telegram bot: @${data.result.username} (id: ${data.result.id})`);
      } else {
        console.log(`❌ Telegram API error: ${data.description}`);
      }
    } catch (err: any) {
      console.log(`❌ Network error: ${err.message}`);
    }
  } else if (name === 'teams') {
    const appId = channel.appId || process.env.MSTEAMS_APP_ID;
    const appPassword = channel.appPassword || process.env.MSTEAMS_APP_PASSWORD;
    if (!appId || !appPassword) {
      console.log('❌ Missing appId or appPassword');
      return;
    }
    try {
      const res = await fetch('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${appId}&client_secret=${encodeURIComponent(appPassword)}&scope=https%3A%2F%2Fapi.botframework.com%2F.default`,
      });
      const data = (await res.json()) as any;
      if (data.access_token) {
        console.log(`✅ Teams auth: token acquired (expires in ${data.expires_in}s)`);
      } else {
        console.log(`❌ Teams auth failed: ${data.error_description || data.error}`);
      }
    } catch (err: any) {
      console.log(`❌ Network error: ${err.message}`);
    }
  } else {
    console.log(`Channel "${name}" test not implemented yet.`);
  }
}
