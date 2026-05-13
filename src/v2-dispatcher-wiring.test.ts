/**
 * Real behavioral tests for installV2DispatcherHooks.
 *
 * Audit finding C (2026-05-01): the NANOCLAW_V2_DISPATCHER hook in
 * src/index.ts main() had ZERO tests. A regression that, say, dropped
 * one of the three install*() calls, or installed gates in the wrong
 * order, would only be caught by a live e2e smoke (which we currently
 * don't gate CI on).
 *
 * This suite injects mock loaders so the wiring can be exercised
 * without booting channels/db/IPC and asserts:
 *   - Each mode (unset / '0' / '1' / '2') routes correctly.
 *   - The three install*() side effects fire in the documented order.
 *   - shadow flag is true iff mode === '2'.
 *   - A throwing loader does NOT propagate; we log + return 'failed'.
 */
import { describe, it, expect, vi } from 'vitest';
import { installV2DispatcherHooks, type V2WiringDeps, type V2WiringLoaders } from './v2-dispatcher-wiring.js';

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps(overrides: Partial<V2WiringDeps> = {}): V2WiringDeps {
  return {
    killActive: vi.fn(() => true),
    sendAck: vi.fn(async () => {}),
    logger: makeLogger(),
    ...overrides,
  };
}

function makeLoaders(
  opts: {
    installAbortFork?: ReturnType<typeof vi.fn>;
    installRegisteredGroupsFork?: ReturnType<typeof vi.fn>;
    loadModulesBarrel?: ReturnType<typeof vi.fn>;
    throwOn?: keyof V2WiringLoaders;
  } = {},
) {
  const installAbortFork = opts.installAbortFork ?? vi.fn();
  const installRegisteredGroupsFork = opts.installRegisteredGroupsFork ?? vi.fn();
  const loadModulesBarrel = opts.loadModulesBarrel ?? vi.fn(async () => ({}));
  const calls: string[] = [];
  const wrap =
    <T>(name: string, fn: () => Promise<T>) =>
    async () => {
      calls.push(name);
      if (opts.throwOn === name) throw new Error(`load failure: ${name}`);
      return fn();
    };
  const loaders: V2WiringLoaders = {
    loadAbortFork: wrap('loadAbortFork', async () => ({ installAbortFork })),
    loadRegisteredGroupsFork: wrap('loadRegisteredGroupsFork', async () => ({ installRegisteredGroupsFork })),
    loadModulesBarrel: wrap('loadModulesBarrel', loadModulesBarrel),
  };
  return {
    loaders,
    spies: {
      installAbortFork,
      installRegisteredGroupsFork,
      loadModulesBarrel,
    },
    calls,
  };
}

describe('installV2DispatcherHooks', () => {
  // #49 step 9.5: v2 is the DEFAULT. Only '0' / 'legacy' opt out.
  it.each(['0', 'legacy'])('mode=%s → disabled, no loaders called', async (mode) => {
    const deps = makeDeps();
    const { loaders, spies, calls } = makeLoaders();
    const out = await installV2DispatcherHooks(mode, deps, loaders);
    expect(out).toEqual({ kind: 'disabled', mode });
    expect(calls).toEqual([]);
    expect(spies.installAbortFork).not.toHaveBeenCalled();
    expect(spies.installRegisteredGroupsFork).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it('default (env unset) installs v2 hooks (regression: v2-default)', async () => {
    const deps = makeDeps();
    const { loaders, spies, calls } = makeLoaders();
    const out = await installV2DispatcherHooks(undefined, deps, loaders);
    expect(out.kind).toBe('installed');
    if (out.kind === 'installed') {
      expect(out.mode).toBe('1');
      expect(out.shadow).toBe(false);
    }
    expect(calls).toEqual(['loadAbortFork', 'loadRegisteredGroupsFork', 'loadModulesBarrel']);
    expect(spies.installAbortFork).toHaveBeenCalledTimes(1);
    expect(spies.installRegisteredGroupsFork).toHaveBeenCalledTimes(1);
  });

  it.each(['1', '2', '', 'foo'] as const)('mode=%s → installed (v2 default path)', async (mode) => {
    const deps = makeDeps();
    const { loaders, spies, calls } = makeLoaders();
    const out = await installV2DispatcherHooks(mode, deps, loaders);

    const expectedMode = mode === '2' ? '2' : '1';
    expect(out).toEqual({
      kind: 'installed',
      mode: expectedMode,
      shadow: expectedMode === '2',
      gates: ['upstream-permissions'],
      abortHandler: 'fork',
      groupResolver: 'registered-groups-extensions',
    });

    // Loaders called in declared order: abort → registered-groups →
    // modules barrel last (per docs/v2-migration-inventory.md
    // "Side-effect import order"). The barrel registers the upstream
    // permissions access gate as a side effect of import.
    expect(calls).toEqual(['loadAbortFork', 'loadRegisteredGroupsFork', 'loadModulesBarrel']);

    // Each install*() called exactly once.
    expect(spies.installAbortFork).toHaveBeenCalledTimes(1);
    expect(spies.installRegisteredGroupsFork).toHaveBeenCalledTimes(1);

    // installAbortFork received the deps we passed in (not a closure
    // over a stale value).
    const abortDeps = spies.installAbortFork.mock.calls[0][0];
    expect(abortDeps.killActive).toBe(deps.killActive);
    expect(abortDeps.sendAck).toBe(deps.sendAck);

    // info log carries the right metadata.
    expect(deps.logger.info).toHaveBeenCalledTimes(1);
    const [logMeta, logMsg] = deps.logger.info.mock.calls[0];
    expect(logMeta).toEqual(
      expect.objectContaining({
        gates: ['upstream-permissions'],
        abortHandler: 'fork',
        groupResolver: 'registered-groups-extensions',
        mode: expectedMode,
        shadow: expectedMode === '2',
      }),
    );
    expect(logMsg).toContain('NANOCLAW_V2_DISPATCHER=' + (mode || 'unset'));
  });

  it('shadow flag is true iff mode is "2" (regression: order matters)', async () => {
    const out1 = await installV2DispatcherHooks('1', makeDeps(), makeLoaders().loaders);
    const out2 = await installV2DispatcherHooks('2', makeDeps(), makeLoaders().loaders);
    expect(out1.kind === 'installed' && out1.shadow).toBe(false);
    expect(out2.kind === 'installed' && out2.shadow).toBe(true);
  });

  it('throwing loader does not propagate; logs error and returns failed outcome', async () => {
    const deps = makeDeps();
    const { loaders } = makeLoaders({ throwOn: 'loadAbortFork' });
    const out = await installV2DispatcherHooks('1', deps, loaders);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.mode).toBe('1');
      expect((out.error as Error).message).toBe('load failure: loadAbortFork');
    }
    expect(deps.logger.error).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it('partial install: if loadRegisteredGroupsFork throws, NO install*() side effects fire (loads-then-installs ordering)', async () => {
    // This pins a real behavioral choice: loaders run first, then
    // install*() in a batch. A failure during loading means none of
    // the install*() side effects fire — cleaner abort semantics than
    // partial-install + manual rollback.
    const deps = makeDeps();
    const { loaders, spies } = makeLoaders({
      throwOn: 'loadRegisteredGroupsFork',
    });
    const out = await installV2DispatcherHooks('2', deps, loaders);
    expect(out.kind).toBe('failed');
    expect(spies.installAbortFork).not.toHaveBeenCalled();
    expect(spies.installRegisteredGroupsFork).not.toHaveBeenCalled();
  });
});
