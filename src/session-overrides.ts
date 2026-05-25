/**
 * Session-scoped slash override resolution.
 *
 * Slash commands like /think, /model, /reasoning write per-session values
 * to the `sessions` table (see db.ts SessionOverrides). At runner-spawn
 * and IPC-message time, the host calls these helpers to compute the
 * "effective" value: session override if set, otherwise the global
 * config default.
 *
 * This mirrors OpenClaw's behavior: slash commands take effect on the
 * NEXT turn of the current session only; new sessions and other chats
 * fall through to the global agent default.
 *
 * To make global changes, users pass `--default` to the slash command,
 * which writes to ~/.nanoclaw/nanoclaw.json instead.
 *
 * Provider routing: GHC and CC store separately keyed by provider
 * column on the sessions row. We resolve the provider from the agent
 * bound to the chat (isAgentGHC).
 */

import { getSessionOverrides, getRegisteredGroup } from './db.js';
import { getConfig } from './config.js';
import { resolveAgentForChat, getAgentModelName, isAgentGHC } from './config-extensions.js';

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';
export type ShowThinking = 'on' | 'off' | 'flash';
export type StreamingMode = 'off' | 'partial' | 'progress';

export function providerForChat(chatJid: string): 'github-copilot' | 'anthropic' {
  const agent = resolveAgentForChat(chatJid);
  return isAgentGHC(agent) ? 'github-copilot' : 'anthropic';
}

/**
 * Resolve the (groupFolder, provider) tuple used to key into the
 * sessions table for slash-command scope.
 *
 * Returns undefined when the chat isn't bound to a registered group
 * (e.g. unregistered DM, scheduled task without a real chat). Callers
 * should fall back to global config in that case.
 */
export function resolveSessionScope(chatJid: string): { groupFolder: string; provider: string } | undefined {
  const group = getRegisteredGroup(chatJid);
  if (!group) return undefined;
  return { groupFolder: group.folder, provider: providerForChat(chatJid) };
}

export function getEffectiveThinkLevel(chatJid: string): ThinkLevel | undefined {
  const scope = resolveSessionScope(chatJid);
  if (scope) {
    const ov = getSessionOverrides(scope.groupFolder, scope.provider);
    if (ov.thinkLevel) return ov.thinkLevel as ThinkLevel;
  }
  const cfg = getConfig().agents?.defaults?.thinkLevel as ThinkLevel | undefined;
  return cfg;
}

export function getEffectiveModel(chatJid: string): string | undefined {
  const scope = resolveSessionScope(chatJid);
  if (scope) {
    const ov = getSessionOverrides(scope.groupFolder, scope.provider);
    if (ov.model) return ov.model;
  }
  const agent = resolveAgentForChat(chatJid);
  return getAgentModelName(agent) ?? undefined;
}

export function getEffectiveShowThinking(chatJid: string): ShowThinking | undefined {
  const scope = resolveSessionScope(chatJid);
  if (scope) {
    const ov = getSessionOverrides(scope.groupFolder, scope.provider);
    if (ov.showThinking) return ov.showThinking as ShowThinking;
  }
  const raw = getConfig().agents?.defaults?.showThinking as boolean | string | undefined;
  if (raw === true) return 'on';
  if (raw === 'flash') return 'flash';
  if (raw === 'on' || raw === 'off') return raw;
  return undefined;
}

/**
 * Resolve the per-chat streaming mode override (from sessions table).
 * Returns undefined when no session-scoped override is set; callers fall
 * back to channel-level config (`channels.<X>.streaming.mode`).
 *
 * Mirrors getEffectiveShowThinking: per-chat overrides win over channel
 * config, channel config wins over the implicit 'off' default. We do NOT
 * read channel config here because the call site
 * (resolveProgressStreamingForChat) already does that as the fallback layer.
 */
export function getEffectiveStreamingOverride(chatJid: string): StreamingMode | undefined {
  const scope = resolveSessionScope(chatJid);
  if (!scope) return undefined;
  const ov = getSessionOverrides(scope.groupFolder, scope.provider);
  const raw = ov.streaming;
  if (raw === 'off' || raw === 'partial' || raw === 'progress') return raw;
  return undefined;
}
