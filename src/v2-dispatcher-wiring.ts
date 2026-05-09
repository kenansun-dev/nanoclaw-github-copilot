/**
 * v2 dispatcher wiring (extracted from src/index.ts main()).
 *
 * Why this lives in its own module: the wiring used to be ~50 lines
 * inside the giant `main()` function, with no test coverage at all
 * (audit 2026-05-01, finding C). Pulling it out lets us:
 *
 *   - Unit-test which hooks fire for each NANOCLAW_V2_DISPATCHER value
 *     (unset / '0' / '1' / '2') without booting channels, db, IPC, etc.
 *   - Mock setAccessGate/installAbortFork/installRegisteredGroupsFork
 *     and assert each is called exactly once with the right shape.
 *   - Verify the catch path: a thrown import keeps the process alive
 *     and falls back to fork v1 only.
 *
 * Production usage from main():
 *
 *   await installV2DispatcherHooks(process.env.NANOCLAW_V2_DISPATCHER, {
 *     killActive: (jid) => queue.killActive(jid),
 *     sendAck:   async (jid, text) => ...,
 *     logger,
 *   });
 *
 * The shape of the dynamic imports is preserved exactly so the existing
 * boot-order documentation in docs/v2-migration-inventory.md still
 * applies. Tests inject overrides via the optional `loaders` param to
 * avoid hitting real fork modules from a unit test.
 */

import type { AccessGateFn } from './router.js';
import type { AbortForkDeps } from './modules/abort-extensions/index.js';

export type V2Mode = string | undefined;

export interface V2WiringDeps {
  /** Kill the active agent for this chat. Return true iff something was killed. */
  killActive: AbortForkDeps['killActive'];
  /** Ack callback for the abort handler. */
  sendAck: NonNullable<AbortForkDeps['sendAck']>;
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export interface V2WiringLoaders {
  loadRouter?: () => Promise<{
    setAccessGate: (gate: AccessGateFn) => void;
  }>;
  loadSenderAllowlist?: () => Promise<{
    makeSenderAllowlistGate: () => AccessGateFn;
  }>;
  loadAbortFork?: () => Promise<{
    installAbortFork: (deps: AbortForkDeps) => void;
  }>;
  loadRegisteredGroupsFork?: () => Promise<{
    installRegisteredGroupsFork: () => void;
  }>;
  loadModulesBarrel?: () => Promise<unknown>;
}

const defaultLoaders: Required<V2WiringLoaders> = {
  loadRouter: () => import('./router.js'),
  loadSenderAllowlist: () => import('./modules/sender-allowlist-extensions/index.js'),
  loadAbortFork: () => import('./modules/abort-extensions/index.js'),
  loadRegisteredGroupsFork: () => import('./modules/registered-groups-extensions/index.js'),
  loadModulesBarrel: () => import('./modules/index.js'),
};

export type V2WiringOutcome =
  | { kind: 'disabled'; mode: V2Mode }
  | {
      kind: 'installed';
      mode: '1' | '2';
      shadow: boolean;
      gates: string[];
      abortHandler: 'fork';
      groupResolver: 'registered-groups-extensions';
    }
  | { kind: 'failed'; mode: V2Mode; error: unknown };

export async function installV2DispatcherHooks(
  v2Mode: V2Mode,
  deps: V2WiringDeps,
  loaders: V2WiringLoaders = {},
): Promise<V2WiringOutcome> {
  if (v2Mode !== '1' && v2Mode !== '2') {
    return { kind: 'disabled', mode: v2Mode };
  }
  const ld = { ...defaultLoaders, ...loaders };

  try {
    const { setAccessGate } = await ld.loadRouter();
    const { makeSenderAllowlistGate } = await ld.loadSenderAllowlist();
    const { installAbortFork } = await ld.loadAbortFork();
    const { installRegisteredGroupsFork } = await ld.loadRegisteredGroupsFork();
    // v2 module barrels self-register on import (approvals, interactive,
    // scheduling, permissions, agent-to-agent, self-mod). Importing
    // here, after channel adapters init, matches the boot order
    // specified in docs/v2-migration-inventory.md §"Side-effect import
    // order".
    await ld.loadModulesBarrel();

    setAccessGate(makeSenderAllowlistGate());
    installAbortFork({
      killActive: deps.killActive,
      sendAck: deps.sendAck,
    });
    installRegisteredGroupsFork();

    const outcome: V2WiringOutcome = {
      kind: 'installed',
      mode: v2Mode,
      shadow: v2Mode === '2',
      gates: ['sender-allowlist'],
      abortHandler: 'fork',
      groupResolver: 'registered-groups-extensions',
    };
    deps.logger.info(
      {
        gates: outcome.gates,
        abortHandler: outcome.abortHandler,
        groupResolver: outcome.groupResolver,
        mode: outcome.mode,
        shadow: outcome.shadow,
      },
      'v2 dispatcher hooks installed (NANOCLAW_V2_DISPATCHER=' + v2Mode + ')',
    );
    return outcome;
  } catch (err) {
    deps.logger.error({ err }, 'v2 dispatcher wiring failed; continuing with fork v1 path only');
    return { kind: 'failed', mode: v2Mode, error: err };
  }
}
