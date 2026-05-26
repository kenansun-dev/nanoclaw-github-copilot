/**
 * Resolver for per-channel `streaming` config. Drives the progress-draft lane.
 *
 * Proposal: docs/proposals/2026-05-23-progress-drafts.md
 *
 * Shape (under `channels.<channel>.streaming`):
 *
 *   {
 *     "mode": "off" | "partial" | "progress",   // default "progress"
 *     "progress": {
 *        "label": "auto" | false | string,
 *        "labels": string[],
 *        "maxLines": number,
 *        "initialDelayMs": number,
 *        "detail": "explain" | "raw",
 *        "finalizePolicy": "edit-in-place" | "release",   // v1 forces "release"
 *     }
 *   }
 *
 * Anything missing -> defaults inside ProgressDraftSession.
 *
 * Reading is intentionally untyped (the `channels` index signature in
 * config-loader.ts is `[key: string]: { enabled; [k: string]: unknown }`),
 * so we treat every nested field as optional + validate shape locally.
 */

import { getConfig } from './config.js';
import { getEffectiveStreamingOverride } from './session-overrides.js';
import type { ProgressDraftOptions } from './progress-draft.js';

export type StreamingMode = 'off' | 'partial' | 'progress';

export interface ResolvedProgressStreaming {
  mode: StreamingMode;
  options: ProgressDraftOptions;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeMode(v: unknown): StreamingMode {
  if (v === 'progress' || v === 'partial' || v === 'off') return v;
  return 'progress';
}

function pickProgressOptions(raw: unknown): ProgressDraftOptions {
  if (!isPlainObject(raw)) return {};
  const out: ProgressDraftOptions = {};
  if (typeof raw.label === 'string' || raw.label === false) out.label = raw.label;
  if (Array.isArray(raw.labels) && raw.labels.every((s) => typeof s === 'string')) {
    out.labels = raw.labels as string[];
  }
  if (typeof raw.initialDelayMs === 'number' && raw.initialDelayMs >= 0) {
    out.initialDelayMs = raw.initialDelayMs;
  }
  if (typeof raw.maxLines === 'number' && raw.maxLines > 0) out.maxLines = raw.maxLines;
  if (typeof raw.maxLineChars === 'number' && raw.maxLineChars > 0) {
    out.maxLineChars = raw.maxLineChars;
  }
  if (raw.detail === 'explain' || raw.detail === 'raw') out.detail = raw.detail;
  if (raw.finalizePolicy === 'edit-in-place' || raw.finalizePolicy === 'release') {
    out.finalizePolicy = raw.finalizePolicy;
  }
  return out;
}

/**
 * Read `channels.<channelName>.streaming` from current config and produce
 * a normalized resolution. Unknown channels / missing block → mode 'progress'
 * (kenan 2026-05-26: progress is the better default UX; users can opt out
 * with `/streaming off` or set `channels.<name>.streaming.mode = "off"`).
 *
 * V1 force: finalizePolicy = 'release' regardless of config, because the
 * dispatcher does not yet implement the edit-in-place handoff (would need
 * to suppress the normal answer send). Proposal Q1 — answer policy deferred
 * to a follow-up commit; users can still configure `edit-in-place` and v1
 * will silently use release. The intent is preserved in the config shape so
 * later phases don't need a migration.
 */
export function resolveProgressStreamingForChannel(channelName: string): ResolvedProgressStreaming {
  const channels = (getConfig().channels as unknown as Record<string, unknown>) ?? {};
  const ch = channels[channelName];
  if (!isPlainObject(ch)) return { mode: 'progress', options: { finalizePolicy: 'release' } };
  const streaming = ch.streaming;
  if (!isPlainObject(streaming)) return { mode: 'progress', options: { finalizePolicy: 'release' } };
  const mode = normalizeMode(streaming.mode);
  const options = pickProgressOptions(streaming.progress);
  // V1: force release; see fn docstring.
  options.finalizePolicy = 'release';
  return { mode, options };
}

/**
 * Like `resolveProgressStreamingForChannel`, but layers a per-chat
 * `/streaming` slash override on top. Used by the dispatcher (one call per
 * turn) so users can flip the progress lane on/off in a specific group
 * without touching `nanoclaw.json`.
 *
 * Resolution order (first match wins for `mode`):
 *   1. session override (sessions.streaming column, written by /streaming)
 *   2. channel-level config (channels.<channelName>.streaming.mode)
 *   3. implicit 'progress' (kenan 2026-05-26: progress is the new default)
 *
 * The `options` block is always read from channel config — per-chat tuning
 * of label/maxLines/etc. is out of scope for v1; the slash only flips mode.
 */
export function resolveProgressStreamingForChat(channelName: string, chatJid: string): ResolvedProgressStreaming {
  const base = resolveProgressStreamingForChannel(channelName);
  const override = getEffectiveStreamingOverride(chatJid);
  if (!override) return base;
  return { mode: override, options: base.options };
}
