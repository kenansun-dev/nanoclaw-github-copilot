/**
 * Slash command registry — B.5-prep #3 skeleton (no callers wired).
 *
 * One of four singleton registries that B.5's dispatcher rewrite of
 * src/index.ts will gate against. See docs/v2-migration-inventory.md
 * §"#4 src/slash-command-registry.ts" for full design rationale.
 *
 * Single-router slot (NOT a list). The fork's `slash-commands.ts`
 * owns the canonical COMMANDS map and is the one router that
 * resolves arbitrary slash inputs. We keep the slot single-valued
 * because the existing router does table-driven dispatch internally
 * — there's no semantic for "compose two slash routers". If that
 * changes later, swap the slot for an ordered list with explicit
 * fallthrough.
 *
 * Currently NO module registers here. `slash-commands.ts` will
 * register `handleSlashCommand` at import time once B.5 lifts the
 * inline `import('./slash-commands.js')` calls out of src/index.ts
 * (lines 369-381 + 1294-1295 per the cut-list). Until then this
 * registry is dormant and `getSlashRouter` returns null.
 *
 * Keep this file dependency-free — no imports from src/index.ts,
 * src/slash-commands.ts, or src/modules/*. `SlashContext` /
 * `SlashResult` are kept structural (and intentionally permissive)
 * so this registry doesn't pull `slash-commands.ts` into the side-
 * effect import chain. `slash-commands.ts` declares its own
 * `SlashCommandContext` / `SlashCommandResult` which are shape-
 * compatible; the registered router can cast on entry.
 */

/** Structural placeholder for `SlashCommandContext` (full type in
 * src/slash-commands.ts). Open-ended to avoid pinning callers. */
export interface SlashContext {
  [k: string]: unknown;
}

/** Structural placeholder for `SlashCommandResult`. */
export interface SlashResult {
  handled: boolean;
  [k: string]: unknown;
}

export type SlashRouter = (
  input: string,
  ctx: SlashContext,
) => Promise<SlashResult>;

let currentRouter: SlashRouter | null = null;

export function registerSlashRouter(router: SlashRouter): void {
  if (currentRouter) {
    throw new Error(
      'slash-command-registry: a router is already registered (single-slot)',
    );
  }
  currentRouter = router;
}

export function getSlashRouter(): SlashRouter | null {
  return currentRouter;
}

/** Test-only: clear slot between tests. NOT exported via barrel. */
export function __resetSlashRouterForTests(): void {
  currentRouter = null;
}
