/**
 * Admin command registry — B.5-prep #3 skeleton (no callers wired).
 *
 * One of four singleton registries that B.5's dispatcher rewrite of
 * src/index.ts will gate against. See docs/v2-migration-inventory.md
 * §"#3 src/admin-command-registry.ts" for full design rationale.
 *
 * Registers exact-match admin commands like /remote-control and
 * /remote-control-end. Match is by exact `name` or any entry in
 * `aliases`, against the trimmed first whitespace-delimited token of
 * the message text. The handler receives the remainder as `args`.
 *
 * Currently NO module registers here. `remote-control.ts` will
 * register at import time once B.5 lifts its handler out of
 * src/index.ts (lines 1788-1832 per the cut-list). Until then this
 * registry is dormant and `lookupAdminCommand` always returns null.
 *
 * Keep this file dependency-free — no imports from src/types.ts,
 * src/index.ts, or src/modules/*. The `msg` param is kept structural
 * (instead of importing NewMessage from src/types.ts) for the same
 * reason rpi5's abort-handler-registry went structural: avoid any
 * TDZ hazard in src/index.ts's side-effect import chain. The B.5
 * dispatcher will pass the real `NewMessage` which is shape-
 * compatible.
 */

/** `NewMessage`-equivalent shape passed to `handler`. Structural to
 * keep the registry dependency-free; full type lives in src/types.ts. */
export interface AdminCommandMessage {
  sender: string;
  content: string;
  // Other NewMessage fields intentionally unconstrained; handlers
  // cast to the full type if they need more context.
  [k: string]: unknown;
}

export type AdminCommandHandler = (chatJid: string, args: string, msg: AdminCommandMessage) => Promise<void>;

export interface AdminCommand {
  /** Primary command token, MUST start with '/' (e.g. '/remote-control'). */
  name: string;
  /** Optional alternate tokens (e.g. ['/remote-control-end']). */
  aliases?: string[];
  handler: AdminCommandHandler;
}

const adminCommands: AdminCommand[] = [];
const byToken = new Map<string, AdminCommand>();

export function registerAdminCommand(cmd: AdminCommand): void {
  if (!cmd.name.startsWith('/')) {
    throw new Error(`admin-command-registry: name must start with '/' (got ${JSON.stringify(cmd.name)})`);
  }
  for (const token of [cmd.name, ...(cmd.aliases ?? [])]) {
    if (byToken.has(token)) {
      throw new Error(
        `admin-command-registry: duplicate token ${JSON.stringify(token)} (already registered by ${byToken.get(token)?.name})`,
      );
    }
    byToken.set(token, cmd);
  }
  adminCommands.push(cmd);
}

/**
 * Look up an admin command by the leading token of `text`.
 * Returns null if no command matches. Whitespace-only or empty input
 * returns null.
 */
export function lookupAdminCommand(text: string): AdminCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const space = trimmed.search(/\s/);
  const token = space === -1 ? trimmed : trimmed.slice(0, space);
  return byToken.get(token) ?? null;
}

/** Test-only: enumerate registered commands (do not mutate the array). */
export function getRegisteredAdminCommands(): readonly AdminCommand[] {
  return adminCommands;
}

/** Test-only: clear registry between tests. NOT exported via barrel. */
export function __resetAdminCommandRegistryForTests(): void {
  adminCommands.length = 0;
  byToken.clear();
}
