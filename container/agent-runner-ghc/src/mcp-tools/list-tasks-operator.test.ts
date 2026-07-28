/**
 * Regression test for owner/operator visibility in the container-side
 * `list_tasks` reader (2026-07-28 Teams bug — see
 * src/tasks-snapshot-operator.test.ts for the full root cause).
 *
 * The container reader filters the `current_tasks.json` snapshot by
 * operator scope. Before the fix it read `NANOCLAW_IS_DEFAULT_AGENT`
 * only, so an owner chatting from a non-default-agent folder saw an
 * empty list. It now honours `NANOCLAW_IS_OPERATOR` (= isDefaultAgent
 * OR isOwner, resolved host-side), falling back to isDefaultAgent when
 * the env is absent (older host writing a new snapshot).
 *
 * These tests pin the env → `isOperator` resolution that drives that
 * filter. `server.ts` reads the env at import time, so each case loads a
 * fresh module via vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = ['NANOCLAW_IS_OPERATOR', 'NANOCLAW_IS_DEFAULT_AGENT', 'NANOCLAW_CHAT_JID', 'NANOCLAW_GROUP_FOLDER'];
const saved: Record<string, string | undefined> = {};

async function loadIsOperator(env: Record<string, string | undefined>): Promise<boolean> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  // Minimal required env for server.ts module-eval (chatJid/groupFolder
  // are non-null asserted at import).
  process.env.NANOCLAW_CHAT_JID = 'teams:conv-1';
  process.env.NANOCLAW_GROUP_FOLDER = 'side';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('./server.js');
  return mod.isOperator;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe('container list_tasks — isOperator env resolution', () => {
  it('owner from a non-default-agent folder is an operator (the bug case)', async () => {
    // isDefaultAgent=0 (folder is NOT the default agent) but host resolved
    // the user as owner → NANOCLAW_IS_OPERATOR=1.
    expect(await loadIsOperator({ NANOCLAW_IS_OPERATOR: '1', NANOCLAW_IS_DEFAULT_AGENT: '0' })).toBe(true);
  });

  it('default-agent is an operator even if IS_OPERATOR is unset (fallback)', async () => {
    expect(await loadIsOperator({ NANOCLAW_IS_DEFAULT_AGENT: '1' })).toBe(true);
  });

  it('non-owner, non-default-agent is NOT an operator (isolation preserved)', async () => {
    expect(await loadIsOperator({ NANOCLAW_IS_OPERATOR: '0', NANOCLAW_IS_DEFAULT_AGENT: '0' })).toBe(false);
  });

  it('no operator env at all → not an operator', async () => {
    expect(await loadIsOperator({})).toBe(false);
  });
});
