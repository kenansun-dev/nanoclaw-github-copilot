/**
 * Tests for slash-command-registry — B.5-prep #3 skeleton.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerSlashRouter,
  getSlashRouter,
  __resetSlashRouterForTests,
  type SlashRouter,
  type SlashContext,
  type SlashResult,
} from './slash-command-registry.js';

beforeEach(() => {
  __resetSlashRouterForTests();
});

describe('slash-command-registry', () => {
  it('returns null until a router is registered', () => {
    expect(getSlashRouter()).toBeNull();
  });

  it('returns the registered router', async () => {
    const router: SlashRouter = vi.fn(
      async (_input: string, _ctx: SlashContext): Promise<SlashResult> => ({
        handled: true,
      }),
    );
    registerSlashRouter(router);
    expect(getSlashRouter()).toBe(router);
  });

  it('rejects a second registration (single-slot)', () => {
    const router: SlashRouter = async () => ({ handled: false });
    registerSlashRouter(router);
    expect(() => registerSlashRouter(router)).toThrow(/single-slot/);
  });
});
