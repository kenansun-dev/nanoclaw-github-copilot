/**
 * Tests for admin-command-registry — B.5-prep #3 skeleton.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAdminCommand,
  lookupAdminCommand,
  getRegisteredAdminCommands,
  __resetAdminCommandRegistryForTests,
  type AdminCommandMessage,
} from './admin-command-registry.js';

const noopHandler = vi.fn(
  async (_jid: string, _args: string, _msg: AdminCommandMessage) => {},
);

beforeEach(() => {
  __resetAdminCommandRegistryForTests();
  noopHandler.mockClear();
});

describe('admin-command-registry', () => {
  it('looks up a command by exact primary name', () => {
    registerAdminCommand({ name: '/remote-control', handler: noopHandler });
    const cmd = lookupAdminCommand('/remote-control extra args');
    expect(cmd?.name).toBe('/remote-control');
  });

  it('looks up a command by alias', () => {
    registerAdminCommand({
      name: '/remote-control',
      aliases: ['/remote-control-end'],
      handler: noopHandler,
    });
    expect(lookupAdminCommand('/remote-control-end')?.name).toBe(
      '/remote-control',
    );
  });

  it('returns null when no command matches', () => {
    registerAdminCommand({ name: '/remote-control', handler: noopHandler });
    expect(lookupAdminCommand('/unknown foo')).toBeNull();
    expect(lookupAdminCommand('')).toBeNull();
    expect(lookupAdminCommand('   ')).toBeNull();
    expect(lookupAdminCommand('hello world')).toBeNull();
  });

  it('rejects names not starting with /', () => {
    expect(() =>
      registerAdminCommand({ name: 'remote-control', handler: noopHandler }),
    ).toThrow(/must start with '\/'/);
  });

  it('rejects duplicate tokens across name or alias', () => {
    registerAdminCommand({ name: '/foo', handler: noopHandler });
    expect(() =>
      registerAdminCommand({ name: '/foo', handler: noopHandler }),
    ).toThrow(/duplicate token/);
    expect(() =>
      registerAdminCommand({
        name: '/bar',
        aliases: ['/foo'],
        handler: noopHandler,
      }),
    ).toThrow(/duplicate token/);
  });

  it('getRegisteredAdminCommands enumerates registered commands', () => {
    registerAdminCommand({ name: '/foo', handler: noopHandler });
    registerAdminCommand({ name: '/bar', handler: noopHandler });
    expect(getRegisteredAdminCommands().map((c) => c.name)).toEqual([
      '/foo',
      '/bar',
    ]);
  });
});
