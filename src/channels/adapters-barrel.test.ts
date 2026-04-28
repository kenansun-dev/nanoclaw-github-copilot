/**
 * Tests for the v2 channel-adapter side-effect barrel
 * (`./adapters-barrel.ts`).
 *
 * Goal: importing the barrel must register all three v2 adapters
 * (discord/telegram/teams) on the v2 channel-registry so the v2
 * router can resolve them by channel type. We do not call
 * `initChannelAdapters()` here — registration should fire from the
 * import side-effect alone, before any factory invocation.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the inner fork channels so the adapter modules can be loaded
// without pulling in grammy / discord.js / botbuilder gateway code.
vi.mock('./discord.js', () => {
  class FakeDiscordChannel {
    constructor() {}
    async connect() {}
    async disconnect() {}
    async sendMessage() {}
    isConnected() {
      return false;
    }
    async setTyping() {}
  }
  return { DiscordChannel: FakeDiscordChannel };
});
vi.mock('./telegram.js', () => {
  class FakeTelegramChannel {
    constructor() {}
    async connect() {}
    async disconnect() {}
    async sendMessage() {}
    isConnected() {
      return false;
    }
    async setTyping() {}
  }
  return { TelegramChannel: FakeTelegramChannel };
});
vi.mock('./teams.js', () => {
  class FakeTeamsChannel {
    constructor() {}
    async connect() {}
    async disconnect() {}
    async sendMessage() {}
    isConnected() {
      return false;
    }
    async setTyping() {}
  }
  return { TeamsChannel: FakeTeamsChannel };
});

describe('v2 channel-adapter barrel', () => {
  it('registers discord/telegram/teams on the v2 channel-registry', async () => {
    // Import the barrel for its side effects.
    await import('./adapters-barrel.js');
    const { getRegisteredChannelNames } = await import('./channel-registry.js');
    const types = getRegisteredChannelNames();
    expect(types).toContain('discord');
    expect(types).toContain('telegram');
    expect(types).toContain('teams');
  });
});
