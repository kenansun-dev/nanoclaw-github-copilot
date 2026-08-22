import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../slash-commands.js';
import { buildTeamsManifest } from './teams-manifest.js';

describe('Teams manifest native slash commands', () => {
  const appId = '00000000-0000-0000-0000-000000000001';
  const manifest = buildTeamsManifest(appId, 'Andy', new Date(2026, 7, 4, 23, 59, 1));
  const bot = manifest.bots[0];

  it('uses schema 1.30 and opts in to targeted messages', () => {
    expect(manifest.$schema).toBe(
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.30/MicrosoftTeams.schema.json',
    );
    expect(manifest.manifestVersion).toBe('1.30');
    expect(manifest.version).toBe('0.260804.235901');
    expect(bot.supportsTargetedMessages).toBe(true);
  });

  it('exposes every command as a native slash command in every chat scope', () => {
    const lists = bot.commandLists as Array<{
      scopes: string[];
      triggers: string[];
      commands: Array<{ title: string; description: string }>;
    }>;
    const commands = lists.flatMap((list) => list.commands);

    expect(lists).toHaveLength(2);
    expect(lists.map((list) => list.commands.length)).toEqual([8, 7]);
    for (const list of lists) {
      expect(list.scopes).toEqual(['personal', 'team', 'groupChat']);
      expect(list.triggers).toEqual(['slash']);
      expect(list.commands.length).toBeLessThanOrEqual(12);
    }

    expect(COMMANDS).toHaveLength(15);
    expect(commands).toHaveLength(COMMANDS.length);
    expect(commands.map((command) => command.title)).toEqual(COMMANDS.map((command) => command.name));
    expect(commands.every((command) => !command.title.startsWith('/'))).toBe(true);
    expect(commands.every((command) => command.description.length <= 128)).toBe(true);
  });
});
