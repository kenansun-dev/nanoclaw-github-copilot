/**
 * ProgressDraftSession — in-chat tool-call status bubble.
 *
 * One instance per chatJid per turn. Renders a single chat message that
 * the host edits as the agent invokes tools, mirroring OpenClaw's
 * `streaming.mode: 'progress'` UX. Completely orthogonal to the
 * thinking-rendering path (`flash` / `on` `<think>` bubble) — this is a
 * THIRD lane, alongside thinking and progressive-answer.
 *
 *   reasoning_delta  -> thinking lane (flash dismiss or `on` keep)
 *   text_delta       -> progressive answer lane (or native stream)
 *   tool.* events    -> progress draft lane (this file)
 *
 * Design (proposal: docs/proposals/2026-05-23-progress-drafts.md):
 *  - Transport-agnostic: takes an opaque `transport` driver so the
 *    session can be unit-tested without a real Channel. Dispatcher
 *    wires Telegram's sendMessage/editMessage in via that adapter.
 *  - Open-gate: first tool event arms a timer. After `initialDelayMs`
 *    OR on the SECOND distinct tool_start event (whichever comes
 *    first), the draft message is opened. This skips the bubble for
 *    snappy turns that only invoke one tool and finish under the
 *    gate threshold.
 *  - Lines: ordered Map<toolCallId, line>. tool_start adds; tool_progress
 *    updates status text; tool_done marks ✓/✗ and (optionally) keeps in
 *    the rolling window. Window size = `maxLines`; oldest DONE lines
 *    rotate out first, in-flight lines are never dropped.
 *  - Detail mode (`explain` | `raw`): explain shows the emoji + tool
 *    label only (or a one-word verb when available); raw appends the
 *    first interesting argument value (path / command / url / query).
 *  - Finalize: caller signals end-of-turn. Two policies:
 *      "edit-in-place"  → final answer text replaces the draft text in
 *                         the same message (no separate answer bubble).
 *                         Default, matches OpenClaw.
 *      "release"        → draft is trimmed to a "✅ done" line and the
 *                         caller delivers the answer as a NEW message.
 *
 * Concurrency: single-threaded JS. State is owned by this object; no
 * locks needed. Pending edits coalesce by overwriting `_latestDraftText`
 * before the in-flight edit settles.
 *
 * Channels using this path MUST guarantee `transport.editDraft()` is
 * safe to call repeatedly with the same target message id; the session
 * dedupes no-op edits when text didn't change since the last write.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire shape mirrors VM's commit 2 envelope on `ContainerOutput.progress`
 * (see docs/proposals/2026-05-23-progress-drafts.md "IPC envelope"). We
 * accept the runtime/runner-emitted object directly so the dispatcher
 * doesn't need a translation layer.
 */
export type ProgressEvent =
  | {
      kind: 'tool_start';
      toolCallId: string;
      toolName: string;
      mcpServerName?: string;
      mcpToolName?: string;
      arguments?: Record<string, unknown>;
    }
  | {
      kind: 'tool_progress';
      toolCallId: string;
      message: string;
    }
  | {
      kind: 'tool_done';
      toolCallId: string;
      success: boolean;
      error?: string;
    };

export type ProgressDetailMode = 'explain' | 'raw';
export type ProgressFinalizePolicy = 'edit-in-place' | 'release';

/**
 * Transport driver supplied by the dispatcher. Two operations:
 *  - sendDraft(text): opens the draft as a fresh chat message and
 *    returns the platform message id. Called at most once per turn.
 *  - editDraft(msgId, text): updates the draft text. May be called
 *    many times; implementations should coalesce / rate-limit.
 *
 * On error, implementations should LOG and resolve (never throw) so a
 * transient platform 429 doesn't abort the turn.
 */
export interface ProgressTransport {
  sendDraft(text: string): Promise<string | undefined>;
  editDraft(msgId: string, text: string): Promise<void>;
}

export interface ProgressDraftOptions {
  label?: string | false;
  /** Pool used when label is "auto" (or omitted). One picked at random per turn. */
  labels?: string[];
  /**
   * How long after the FIRST tool event we wait before opening the
   * draft. Default 5000 ms (OpenClaw parity). Set 0 to open immediately
   * on the first tool event.
   */
  initialDelayMs?: number;
  /**
   * Maximum number of tool lines visible below the label. Older DONE
   * lines drop off first; in-flight lines are never dropped. Default 4.
   */
  maxLines?: number;
  /**
   * Max characters per rendered tool line before truncation. Default 120.
   */
  maxLineChars?: number;
  /** explain | raw. Default explain. */
  detail?: ProgressDetailMode;
  /** edit-in-place | release. Default edit-in-place. */
  finalizePolicy?: ProgressFinalizePolicy;
}

const DEFAULT_OPTIONS: Required<ProgressDraftOptions> = {
  label: 'auto',
  labels: ['Working…', 'On it…', 'One moment…', 'Cooking…', 'Shelling…', 'Looking…'],
  initialDelayMs: 5000,
  maxLines: 4,
  maxLineChars: 120,
  detail: 'explain',
  finalizePolicy: 'edit-in-place',
};

interface ToolLine {
  toolCallId: string;
  toolName: string;
  emoji: string;
  title: string;
  detail?: string;
  /** Latest mid-flight progress status (overrides the args detail when present). */
  progressMessage?: string;
  /** Undefined while in-flight, true/false once tool_done arrives. */
  success?: boolean;
  errorSummary?: string;
  /** Insertion order for stable line rotation. */
  seq: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool display catalog (minimal seed — extend as new MCP tools surface)
// ─────────────────────────────────────────────────────────────────────────────

interface ToolDisplaySpec {
  emoji: string;
  title: string;
  /** Argument keys to consult (in order) for the "raw" detail string. */
  detailKeys?: string[];
}

const FALLBACK_SPEC: ToolDisplaySpec = {
  emoji: '🧩',
  title: 'Tool',
  detailKeys: ['command', 'path', 'url', 'query', 'pattern', 'message', 'name', 'id'],
};

const TOOL_DISPLAY: Record<string, ToolDisplaySpec> = {
  bash: { emoji: '🛠️', title: 'Bash', detailKeys: ['command'] },
  exec: { emoji: '🛠️', title: 'Bash', detailKeys: ['command'] },
  shell: { emoji: '🛠️', title: 'Shell', detailKeys: ['command'] },
  read: { emoji: '📖', title: 'Read', detailKeys: ['path', 'file_path'] },
  write: { emoji: '✍️', title: 'Write', detailKeys: ['path', 'file_path'] },
  edit: { emoji: '📝', title: 'Edit', detailKeys: ['path', 'file_path'] },
  grep: { emoji: '🔎', title: 'Grep', detailKeys: ['pattern'] },
  glob: { emoji: '🔎', title: 'Glob', detailKeys: ['pattern'] },
  ls: { emoji: '📁', title: 'List', detailKeys: ['path'] },
  web_fetch: { emoji: '🌐', title: 'Fetch', detailKeys: ['url'] },
  web_search: { emoji: '🌐', title: 'Search', detailKeys: ['query'] },
  schedule_task: { emoji: '⏰', title: 'Schedule', detailKeys: ['name', 'when'] },
  send_message: { emoji: '💬', title: 'Send', detailKeys: ['to', 'channel'] },
  // MCP-wrapped variants (some servers prefix tool names; allow lookups
  // by the prefix-stripped suffix as well — see resolveSpec).
};

function normalizeToolName(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Returns a display spec for the given tool. Tries:
 *   1. Exact lowercase match
 *   2. Suffix after the last `_` or `.` (MCP `nanoclaw_schedule_task`
 *      → `schedule_task`)
 *   3. Fallback emoji + the original toolName as title (Title Case)
 */
export function resolveProgressToolSpec(toolName: string | undefined): {
  emoji: string;
  title: string;
  detailKeys: string[];
} {
  const lower = normalizeToolName(toolName);
  if (!lower) {
    return { emoji: FALLBACK_SPEC.emoji, title: FALLBACK_SPEC.title, detailKeys: FALLBACK_SPEC.detailKeys ?? [] };
  }
  if (TOOL_DISPLAY[lower]) {
    const spec = TOOL_DISPLAY[lower];
    return { emoji: spec.emoji, title: spec.title, detailKeys: spec.detailKeys ?? [] };
  }
  const lastDot = Math.max(lower.lastIndexOf('_'), lower.lastIndexOf('.'));
  if (lastDot > 0) {
    const suffix = lower.slice(lastDot + 1);
    if (TOOL_DISPLAY[suffix]) {
      const spec = TOOL_DISPLAY[suffix];
      return { emoji: spec.emoji, title: spec.title, detailKeys: spec.detailKeys ?? [] };
    }
  }
  // Try peeling longer suffixes greedily on `_` boundaries so
  // `nanoclaw_send_message` matches `send_message` (the catalog key)
  // even though `message` doesn't.
  {
    const parts = lower.split(/[_.]/);
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join('_');
      if (TOOL_DISPLAY[tail]) {
        const spec = TOOL_DISPLAY[tail];
        return { emoji: spec.emoji, title: spec.title, detailKeys: spec.detailKeys ?? [] };
      }
    }
  }
  // Fallback — title-case from the raw name so display still reads OK.
  const titled =
    toolName!
      .replace(/[_.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase()) || FALLBACK_SPEC.title;
  return { emoji: FALLBACK_SPEC.emoji, title: titled, detailKeys: FALLBACK_SPEC.detailKeys ?? [] };
}

function pickDetail(args: Record<string, unknown> | undefined, detailKeys: readonly string[]): string | undefined {
  if (!args) return undefined;
  for (const key of detailKeys) {
    const raw = args[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Pure-function renderer for a single tool line. Exported for tests.
 */
export function renderProgressLine(line: ToolLine, detail: ProgressDetailMode, maxLineChars: number): string {
  // Status prefix: in-flight gets the tool emoji; done gets ✓ / ✗ stacked
  // to the right so the eye lands on the tool name not the verdict.
  const statusSuffix =
    line.success === undefined ? '' : line.success ? ' ✓' : line.errorSummary ? ` ✗ ${line.errorSummary}` : ' ✗';
  let body = `${line.emoji} ${line.title}`;
  // Detail rules:
  //  - progressMessage (from MCP server) always wins if present, regardless of mode
  //  - explain: no extra detail
  //  - raw: append the arg-derived detail in monospace-friendly form
  if (line.progressMessage) {
    body += `: ${line.progressMessage}`;
  } else if (detail === 'raw' && line.detail) {
    body += `: ${line.detail}`;
  }
  return truncate(body + statusSuffix, maxLineChars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgressDraftSession {
  /** Feed a runner-emitted progress event. */
  apply(event: ProgressEvent): void;
  /**
   * Caller signals end-of-turn with the final answer text. Resolves
   * once any pending edit settles. After this returns, no further
   * apply() calls will produce wire traffic.
   *
   * Returns the message id of the draft (so dispatcher can decide
   * whether to skip sending a separate answer message when policy is
   * "edit-in-place"). Undefined if the draft was never opened
   * (sub-gate-duration turn with one or zero tool events).
   */
  finalize(finalAnswerText: string): Promise<string | undefined>;
  /**
   * Tear down without rendering a finalization. Used on error /
   * cancellation so timers are cleared and no more wire traffic
   * happens.
   */
  abandon(): void;
  /** True iff the draft message has been opened on the wire. Exposed for tests + dispatcher heuristics. */
  isOpen(): boolean;
}

interface CreateArgs {
  transport: ProgressTransport;
  options?: ProgressDraftOptions;
  /**
   * Optional clock override for tests. `setTimeout` and `clearTimeout`
   * with the standard signatures.
   */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /**
   * Optional logger; if omitted, errors are swallowed silently (caller's
   * dispatcher already logs wire errors at the transport boundary).
   */
  onError?: (err: Error, context: { stage: 'open' | 'edit' | 'finalize' }) => void;
  /** Optional RNG override for label="auto" picking. Returns 0–1. */
  rng?: () => number;
}

export function createProgressDraftSession(args: CreateArgs): ProgressDraftSession {
  const opts: Required<ProgressDraftOptions> = {
    ...DEFAULT_OPTIONS,
    ...(args.options ?? {}),
    // Spread again so explicit user values override; nested array/object props
    // shallow-copy fine since none of them are objects.
  };
  const transport = args.transport;
  const scheduler = args.scheduler ?? {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const onError = args.onError ?? (() => {});
  const rng = args.rng ?? Math.random;

  // ── State ──
  const lines = new Map<string, ToolLine>();
  let lineSeq = 0;
  let openTimer: unknown = null;
  /** Count of distinct tool_start events seen — used for the "2nd event" gate trigger. */
  let toolStartCount = 0;
  /** True once the draft has actually been sent to the wire. */
  let draftMsgId: string | undefined;
  /** Snapshot of the last text we sent on the wire. Dedupe no-op edits. */
  let lastSent: string | undefined;
  /** True once finalize() has been called; ignore subsequent applies. */
  let finalized = false;
  /** True if abandoned; ignore everything. */
  let abandoned = false;
  /**
   * Pending text waiting to be edited onto the draft message. The
   * worker loop coalesces by reading the latest snapshot after each
   * settled write.
   */
  let pendingText: string | undefined;
  let editInFlight: Promise<void> | null = null;
  /** Resolved when the open-attempt (if any) finishes; finalize() awaits it. */
  let openAttempt: Promise<void> | null = null;

  // ── Helpers ──

  function resolvedLabel(): string | undefined {
    if (opts.label === false) return undefined;
    if (typeof opts.label === 'string' && opts.label !== 'auto') return opts.label;
    const pool = opts.labels.length ? opts.labels : DEFAULT_OPTIONS.labels;
    const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
    return pool[idx];
  }
  // Pick the label ONCE per session so multiple edits don't shuffle it.
  const cachedLabel = resolvedLabel();

  function visibleLines(): ToolLine[] {
    // Stable order: by seq ascending = insertion order. Drop oldest DONE
    // lines first if over budget; never drop in-flight.
    const all = Array.from(lines.values()).sort((a, b) => a.seq - b.seq);
    if (all.length <= opts.maxLines) return all;
    const overflow = all.length - opts.maxLines;
    const result: ToolLine[] = [];
    let dropped = 0;
    for (const line of all) {
      if (dropped < overflow && line.success !== undefined) {
        dropped++;
        continue;
      }
      result.push(line);
    }
    return result;
  }

  function renderDraftText(): string {
    const parts: string[] = [];
    if (cachedLabel) parts.push(cachedLabel);
    for (const line of visibleLines()) {
      parts.push(renderProgressLine(line, opts.detail, opts.maxLineChars));
    }
    return parts.join('\n');
  }

  function scheduleOpen(): void {
    if (draftMsgId || openTimer || abandoned || finalized) return;
    if (opts.initialDelayMs <= 0) {
      // Immediate open path.
      openTimer = null;
      void openDraftNow();
      return;
    }
    openTimer = scheduler.setTimeout(() => {
      openTimer = null;
      void openDraftNow();
    }, opts.initialDelayMs);
  }

  async function openDraftNow(): Promise<void> {
    if (draftMsgId || abandoned || finalized) return;
    const text = renderDraftText();
    if (!text) return;
    openAttempt = (async () => {
      try {
        const id = await transport.sendDraft(text);
        if (typeof id === 'string') {
          draftMsgId = id;
          lastSent = text;
        }
      } catch (err) {
        onError(err as Error, { stage: 'open' });
      }
    })();
    await openAttempt;
    // If lines changed during the open round-trip, flush the diff.
    enqueueEdit(renderDraftText());
  }

  function enqueueEdit(text: string): void {
    if (!draftMsgId || abandoned) return;
    pendingText = text;
    if (editInFlight) return;
    // Mark in-flight synchronously BEFORE invoking drainEdits so its
    // own final `editInFlight = null` cannot be overwritten by this
    // assignment when drainEdits runs to completion without awaits.
    editInFlight = Promise.resolve();
    void drainEdits();
  }

  async function drainEdits(): Promise<void> {
    while (pendingText !== undefined && draftMsgId && !abandoned) {
      const snapshot = pendingText;
      pendingText = undefined;
      if (snapshot === lastSent) continue;
      try {
        await transport.editDraft(draftMsgId, snapshot);
        lastSent = snapshot;
      } catch (err) {
        onError(err as Error, { stage: 'edit' });
      }
    }
    editInFlight = null;
  }

  // ── Public API ──

  function apply(event: ProgressEvent): void {
    if (abandoned || finalized) return;
    switch (event.kind) {
      case 'tool_start': {
        if (lines.has(event.toolCallId)) return; // dedupe
        const spec = resolveProgressToolSpec(event.toolName);
        const detail = pickDetail(event.arguments, spec.detailKeys);
        lines.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          emoji: spec.emoji,
          title: spec.title,
          detail,
          seq: lineSeq++,
        });
        toolStartCount++;
        // Gate: open immediately on the 2nd distinct tool_start
        // (work-event override), otherwise wait out the delay.
        if (!draftMsgId && toolStartCount >= 2) {
          if (openTimer) {
            scheduler.clearTimeout(openTimer);
            openTimer = null;
          }
          void openDraftNow();
        } else {
          scheduleOpen();
        }
        if (draftMsgId) enqueueEdit(renderDraftText());
        break;
      }
      case 'tool_progress': {
        const line = lines.get(event.toolCallId);
        if (!line) return;
        line.progressMessage = event.message;
        if (draftMsgId) enqueueEdit(renderDraftText());
        break;
      }
      case 'tool_done': {
        const line = lines.get(event.toolCallId);
        if (!line) return;
        line.success = event.success;
        line.progressMessage = undefined; // clear in-flight status
        if (event.error) line.errorSummary = truncate(event.error.replace(/\s+/g, ' ').trim(), 60);
        if (draftMsgId) enqueueEdit(renderDraftText());
        break;
      }
    }
  }

  async function finalize(finalAnswerText: string): Promise<string | undefined> {
    if (finalized || abandoned) return draftMsgId;
    finalized = true;
    if (openTimer) {
      scheduler.clearTimeout(openTimer);
      openTimer = null;
    }
    // Wait for any in-flight open attempt; it may have set draftMsgId.
    if (openAttempt) {
      try {
        await openAttempt;
      } catch (err) {
        onError(err as Error, { stage: 'finalize' });
      }
    }
    if (!draftMsgId) {
      // Never opened — caller should deliver the final answer normally.
      return undefined;
    }
    // Final-edit text per policy.
    const text = opts.finalizePolicy === 'edit-in-place' ? finalAnswerText : buildReleaseText();
    enqueueEdit(text);
    if (editInFlight) {
      try {
        await editInFlight;
      } catch (err) {
        onError(err as Error, { stage: 'finalize' });
      }
    }
    return draftMsgId;
  }

  function buildReleaseText(): string {
    const parts: string[] = [];
    if (cachedLabel) parts.push(cachedLabel);
    const all = Array.from(lines.values());
    const done = all.filter((l) => l.success === true).length;
    const fail = all.filter((l) => l.success === false).length;
    const summary = fail > 0 ? `✅ ${done} done, ❌ ${fail} failed` : done > 0 ? `✅ ${done} done` : '✅ done';
    parts.push(summary);
    return parts.join('\n');
  }

  function abandon(): void {
    if (abandoned) return;
    abandoned = true;
    if (openTimer) {
      scheduler.clearTimeout(openTimer);
      openTimer = null;
    }
    // Don't touch the wire on abandon — caller is in error/cancel
    // path and is responsible for any user-visible cleanup.
  }

  function isOpen(): boolean {
    return !!draftMsgId;
  }

  return { apply, finalize, abandon, isOpen };
}
