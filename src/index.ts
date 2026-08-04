import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { paths } from './workspace.js';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  DATA_DIR,
  GROUPS_DIR,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  getConfig,
} from './config.js';
import { getEffectiveShowThinking } from './session-overrides.js';
import { createFlashEditCoalescer } from './flash-edit-coalescer.js';
import { runAgentForChat, IS_GHC_PROVIDER, resolveAgentForChat, getAgentProvider } from './config-extensions.js';
import './channels/index.js';
import { getChannelFactory, getRegisteredChannelNames } from './channels/registry.js';
import { ContainerOutput, writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { createProgressDraftSession, type ProgressDraftSession } from './progress-draft.js';
import { createProgressTransport } from './progress-draft-transport.js';
import { resolveProgressStreamingForChat } from './streaming-config.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getRecentConversation,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { isAbortRequestText } from './abort-triggers.js';
import { shadowRoute } from './shadow-inbound.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { folderIsDefaultAgent } from './v2-default-agent.js';
import { isOwner } from './modules/permissions/db/user-roles.js';
import { findChannel, formatMessages, formatOutbound, formatConversationContext } from './text-format.js';
import { restoreRemoteControl, startRemoteControl, stopRemoteControl } from './remote-control.js';
import { isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage } from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler-bridge.js';
import { Channel, NewMessage, RegisteredGroup } from './types-extensions.js';
import { logger } from './log-extensions.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './text-format.js';

let lastTimestamp = '';
// sessions: groupFolder → provider → sessionId. Each provider stores its
// CLI sessions in a different on-disk path, so we key by both.
let sessions: Record<string, Record<string, string>> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// OneCLI is only used for CC (Anthropic) provider
const onecli = IS_GHC_PROVIDER ? null : new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  // v2-only (PR #49): folder is the default-agent? Compute on demand.
  if (!onecli || folderIsDefaultAgent(group.folder) === true) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli!.ensureAgent({ name: group.name, identifier }).then(
    (res: any) => {
      logger.info({ jid, identifier, created: res.created }, 'OneCLI agent ensured');
    },
    (err: any) => {
      logger.debug({ jid, identifier, err: String(err) }, 'OneCLI agent ensure skipped');
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info({ chatJid, recoveredFrom: botTs }, 'Recovered message cursor from last bot reply');
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/**
 * Wrapper around channel.setTyping that adds an INFO log for telemetry.
 * Used to debug "typing indicator stuck on" symptoms (e.g. when an agent
 * dies after being told it's typing). All call sites should go through
 * this so the lifecycle is observable in logs.
 */
function traceSetTyping(
  channel: {
    name: string;
    setTyping?: (jid: string, isTyping: boolean) => Promise<void>;
  },
  chatJid: string,
  isTyping: boolean,
  reason: string,
): Promise<void> {
  if (!channel.setTyping) return Promise.resolve();
  // Any explicit state change cancels a pending bounded auto-clear so it
  // doesn't fire after a follow-on event has already managed the state.
  cancelBoundedTypingClear(chatJid);
  logger.info({ chatJid, channel: channel.name, isTyping, reason }, 'Channel typing state change');
  return channel.setTyping(chatJid, isTyping).catch((err: any) => {
    logger.warn(
      {
        chatJid,
        channel: channel.name,
        isTyping,
        reason,
        err: err?.message ?? err,
      },
      'channel.setTyping failed',
    );
  });
}

/**
 * Per-chat auto-clear timers for bounded typing re-arms. Used by
 * `armTypingBounded` so an interim re-arm cannot get stuck if the agent
 * silently exits without firing turn-end (or if turn-end is delayed by a
 * runner idle window). Any subsequent traceSetTyping cancels the pending
 * clear so we don't double-toggle in the normal multi-step flow.
 *
 * Why this exists (kenan repro 2026-04-27): the original re-arm armed an
 * unbounded 3s keepalive interval after every interim final-output,
 * including the last one. Between the last final and turn-end (which can
 * be 30s+ for slow runner shutdowns), Teams kept showing 'typing forever'.
 */
// Typing pulse state machine: see src/typing-pulse.ts for the unit
// tests + behavioral contract. We keep `boundedTypingTimers` here only
// as the shared state map; the helpers delegate to typing-pulse.ts.
import {
  createTypingPulseState,
  cancelBoundedTypingClear as _cancelBoundedTypingClear,
  armTypingBounded as _armTypingBounded,
} from './typing-pulse.js';

const typingPulseState = createTypingPulseState({
  warn: (obj, msg) => logger.warn(obj, msg ?? 'typing pulse warn'),
});
const boundedTypingTimers = typingPulseState.timers;

/**
 * TTL for the bounded typing pulse after an interim final-output. Long
 * enough to bridge a normal think-then-act gap (a few seconds) without
 * leaving the indicator stuck if no follow-up output arrives. Channels
 * tick their own keepalive at 3-4s, so 8s comfortably covers ~2 ticks.
 */
const INTERIM_TYPING_TTL_MS = 8000;

function cancelBoundedTypingClear(chatJid: string): void {
  _cancelBoundedTypingClear(typingPulseState, chatJid);
}

/**
 * Re-arm typing as a bounded pulse: arms the channel keepalive, then
 * schedules an auto-clear after `ttlMs` if nothing else has touched
 * typing in the meantime. The next traceSetTyping (any direction)
 * cancels the pending clear via cancelBoundedTypingClear.
 *
 * We log the trace info here (kept for parity with traceSetTyping) and
 * then delegate the actual setTyping + timer install to the pure helper.
 */
async function armTypingBounded(
  channel: {
    name: string;
    setTyping?: (jid: string, isTyping: boolean) => Promise<void>;
  },
  chatJid: string,
  reason: string,
  ttlMs: number,
): Promise<void> {
  logger.info({ chatJid, channel: channel.name, isTyping: true, reason }, 'Channel typing state change');
  await _armTypingBounded(typingPulseState, channel, chatJid, ttlMs);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err: any) {
    logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    // Bucket A: dual-read for CLAUDE.md template path (mount-derived).
    const isDefaultAgentTpl = folderIsDefaultAgent(group.folder) === true;
    const templateFile = path.join(DATA_DIR, GROUPS_DIR, isDefaultAgentTpl ? 'main' : 'global', 'CLAUDE.md');
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isDefaultAgentGroup = folderIsDefaultAgent(group.folder) === true;

  let missedMessages = getMessagesSince(chatJid, getOrRecoverCursor(chatJid), ASSISTANT_NAME, MAX_MESSAGES_PER_PROMPT);

  if (missedMessages.length === 0) return true;

  // Handle slash commands in ALL messages, not just the last one.
  // Separate slash commands from regular messages to avoid swallowing.
  const { normalizeSlashInput, handleSlashCommand } = await import('./slash-commands.js');
  const { parseChatJid } = await import('./shadow-inbound.js');
  const slashCtx = {
    chatJid,
    groupFolder: group.folder,
    channel: findChannel(channels, chatJid),
    clearSession: (folder: string) => delete sessions[folder],
    killActiveRunner: (jid: string) => queue.killActive(jid),
  };
  const regularMessages: typeof missedMessages = [];
  // Bucket B (Step 3+4): qualify per-message senderId so /tasks et al.
  // can run owner checks via v2 user_roles. parseChatJid maps known
  // chatJid prefixes (tg:/discord:/teams:/...) to channelType; rawId
  // comes from the inbound message's `sender` column (db.ts:427).
  // chatJid is fixed for this batch — lift the parse out of the loop
  // (VM review nit on Bucket B).
  const parsedJid = parseChatJid(chatJid);
  for (const msg of missedMessages) {
    const slashInput = normalizeSlashInput(msg.content);
    const senderId = parsedJid && msg.sender ? `${parsedJid.channelType}:${msg.sender}` : undefined;
    const slashResult = await handleSlashCommand(slashInput, { ...slashCtx, senderId });
    if (slashResult.handled) {
      lastAgentTimestamp[chatJid] = msg.timestamp;
    } else {
      regularMessages.push(msg);
    }
  }
  saveState();

  if (regularMessages.length === 0) return true;

  // Channel-qualified user id of the LAST sender in this batched turn.
  // Used by the in-container MCP server to stamp IPC payloads so the host
  // can apply isOwner privilege gates (HR list #3, isOwner phase 1).
  // parsedJid is already computed above (line ~323). Falls back to
  // undefined when sender or parsedJid is missing.
  const lastSenderMsg = regularMessages[regularMessages.length - 1];
  const triggeringUserId =
    parsedJid && lastSenderMsg?.sender ? `${parsedJid.channelType}:${lastSenderMsg.sender}` : undefined;

  // Replace missedMessages with non-slash messages for further processing
  missedMessages = regularMessages;

  // For non-main groups, check if trigger is required and present
  // (after slash commands, so /think etc. work without @mention)
  if (!isDefaultAgentGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) && (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Include recent conversation history so model has context
  const recentHistory = getRecentConversation(chatJid);
  const historyPrefix = formatConversationContext(
    recentHistory.filter((m) => !missedMessages.some((mm) => mm.id === m.id)),
    TIMEZONE,
    ASSISTANT_NAME,
  );
  const newMessages = formatMessages(missedMessages, TIMEZONE);
  const prompt = historyPrefix ? historyPrefix + '\n\n' + newMessages : newMessages;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  queue.setCurrentTurnStartCursor(chatJid, previousCursor);
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  // Container idle-close is now handled by host-sweep (heartbeat mtime +
  // claim-stuck detection) rather than an in-process setTimeout. Host mode
  // is long-lived by design. Aligns with upstream which has no IDLE_TIMEOUT.
  await traceSetTyping(channel, chatJid, true, 'turn-start');
  // Defense-in-depth: even if runAgent rejects (unhandled), an editMessage
  // throws, or any unexpected error escapes the try block, the typing
  // indicator MUST be released and the idle timer MUST be cleared.
  // The happy-path setTyping(false, 'turn-end') is kept inline for telemetry
  // clarity; the finally block is the safety net so we never leave Teams
  // pinned to typing for hours after a crash. (rpi5's onProcessDiedWithoutOutput
  // callback in group-queue covers the host-process-died case; this finally
  // covers the in-process throw / promise-rejection case. They overlap on
  // purpose — cheap, idempotent, no harm calling setTyping(false) twice.)
  let hadError = false;
  let outputSentToUser = false;
  // A1/A2 (2026-08-03): true once a plain-message terminal fallback has
  // been published, so the Bug-2 coalesce flush, the A2 stream-failure
  // fallback, and the A1 finally-guard can never double-send the same
  // reply.
  let deliveredPlainFallback = false;
  // Exactly one dispatcher-level plain terminal is allowed per turn. The
  // channel-level streaming session may already have attempted its own final
  // fallback; this gate covers coalesce/A1/A2/finally so they cannot race or
  // double-send after the asynchronous wire result becomes visible.
  let terminalPlainAttempted = false;
  let terminalFailureHandled = false;
  const initialUserTurnSeq = queue.getUserTurnSeq(chatJid);
  // A2: set when native streaming end() reported total delivery failure
  // (endFailed()===true). Drives a single plain-message delivery attempt +
  // cursor rollback after the output loop.
  let streamDeliveryFailed = false;
  let streamFailureFinalText = '';
  // Progressive send state: track message ID for editMessage on partial updates
  let progressiveMsgId: string | undefined;
  let progressiveText = '';
  // Thinking-stream lane: a SEPARATE message id from progressiveMsgId
  // (which carries the answer). SDK emits reasoning_delta and text_delta
  // CONCURRENTLY (no ordering guarantee), so sharing one message id caused
  // the partial answer and reasoning preview to overwrite each other and
  // visually flicker (kenan reported this twice).
  //
  // Two-lane design (mirrors openclaw's bot-message-dispatch.ts):
  //   reasoning_delta -> render/edit `thinkingMsgId` (independent)
  //   text_delta      -> render/edit `progressiveMsgId`    (independent)
  //
  // Mode behavior at finalize:
  //   `flash` -> on first answer chunk, DELETE thinkingMsgId (fallback edit
  //             to a single space if channel lacks deleteMessage). Spec
  //             from kenan 2026-04-24: "thinking 内容删掉".
  //   `on`    -> finalize thinkingMsgId by stripping trailing ◌; KEEP it
  //             visible above the answer. Spec from kenan 2026-04-24:
  //             "thinking 和主消息都是 streaming回来, 都保留".
  //   `off`   -> never opened.
  let thinkingMsgId: string | undefined;
  // On-mode dedup: a single agent query may emit multiple `partial=false`
  // result events when it contains tool calls (pre-tool final + post-tool
  // final). Each event carries the SDK's accumulated `result.thinking`,
  // and the legacy code prepended thinking on every one — so users saw the
  // (growing) thinking block rendered twice in `on` mode (kenan TG repro
  // 2026-04-25 18:06). This flag clamps the prepend to the FIRST final of
  // a query; reset on the query boundary along with thinkingMsgId.
  let thinkingPrependedThisQuery = false;
  // True once flash mode has cleared its thinking preview on the first
  // answer chunk; suppresses re-opening a thinking message for the
  // remainder of the turn (SDK still emits trailing reasoning_delta).
  let flashThinkingDismissed = false;
  // Last thinking text we rendered to thinkingMsgId for the CURRENT turn.
  // Used to dedupe re-edits in `on` mode: result.result fires per partial
  // answer chunk, but we only need to update the thinking message when its
  // text actually grew. Skipping no-op edits keeps us off TG's per-chat
  // 30/sec rate limit. Reset on turn boundary along with thinkingMsgId.
  let lastThinkingRendered: string | undefined;
  // Flash opening lock: SDK fires reasoning_delta events at high rate.
  // The first delta enters the `if (!thinkingMsgId)` branch and awaits
  // channel.sendMessage; while that promise is in flight, a second delta
  // arrives, ALSO sees thinkingMsgId === undefined, ALSO calls sendMessage
  // → two orphan opening bubbles on screen (kenan repro 2026-04-25 18:05
  // on TG flash mode). The coalescer protects edits-after-msgId-known but
  // had no protection for the open-msgId race. See createOpeningLock().
  const flashOpeningLock = createOpeningLock();
  // Flash thinking edit coalescer: see src/flash-edit-coalescer.ts.
  // Cleared on every turn boundary along with thinkingMsgId.
  const flashEditCoalescer = createFlashEditCoalescer({
    channel,
    chatJid,
    onOrphan: () => {
      flashThinkingDismissed = true;
      thinkingMsgId = undefined;
    },
  });
  let lastFinalMsgId: string | undefined;
  // Native streaming state: when channel.usesNativeStreaming, we open a
  // StreamHandle on the first partial and feed it cumulative text. The
  // legacy progressiveMsgId path is bypassed entirely. See
  // src/types.ts:Channel.usesNativeStreaming docstring for why this is
  // a separate code path from editMessage-based partial accumulation.
  let streamHandle: import('./types-extensions.js').StreamHandle | undefined;
  // Bug 2 fallback (proposal docs/proposals/2026-05-29-teams-streaming-multi-final-fix.md).
  // When the native streaming wire dies mid-turn (server rejects an
  // activity → `_cancelled` flips inside the channel session) subsequent
  // `result.partial=false` outputs from a multi-step agent turn would
  // otherwise each hit `channel.sendMessage()` and produce one DM bubble
  // per output (kenan Teams repro 2026-05-28: 13–34 bubbles per turn).
  // When this flag transitions to an array we route every remaining final
  // text from the turn into the buffer and flush a single concatenated
  // `channel.sendMessage()` at turn-end / in the finally-guard. If Bug 1
  // is healthy (`isCancelled()` never trips mid-turn) this code path is
  // never entered and behaviour is unchanged.
  let streamDiedCoalesced: string[] | undefined;
  // Bug 2 helper: probe whether the native streaming wire died and arm the
  // coalesce buffer if so. Called after every operation that funnels into
  // the wire (`chunk`, `appendThinking`) — wire-cancel can flip mid-drain
  // regardless of which entry point we used. Idempotent (gated on
  // `streamDiedCoalesced === undefined`). Returns true if it tripped this
  // call so the caller can null out its handle reference.
  const probeWireDeath = (where: string): boolean => {
    if (!streamHandle) return false;
    if (streamHandle.isCancelled?.() !== true) return false;
    if (streamDiedCoalesced !== undefined) return false;
    logger.warn(
      { chatJid, group: group.name, where },
      'native streaming wire cancelled mid-turn; switching to coalesced-final fallback',
    );
    streamDiedCoalesced = [];
    streamHandle = undefined;
    return true;
  };

  // chunk() is intentionally fire-and-forget, so an immediate probe can run
  // before Bot Connector's 400/timeout flips isCancelled(). At a terminal
  // boundary, wait for the bounded channel drain before making the delivery
  // decision. This closes the bootstrap-reject -> explicit-cancel race.
  const settleAndProbeWireDeath = async (where: string): Promise<void> => {
    const activeHandle = streamHandle;
    if (!activeHandle) return;
    try {
      await activeHandle.settle?.();
    } catch (err) {
      logger.warn(
        { chatJid, group: group.name, endPath: where, err: (err as Error).message },
        'native streaming terminal settle failed',
      );
    }
    if (streamHandle === activeHandle) probeWireDeath(where);
  };

  const sendPlainTerminal = async (text: string, endPath: string): Promise<boolean> => {
    if (terminalPlainAttempted || deliveredPlainFallback || !text.trim()) return deliveredPlainFallback;
    terminalPlainAttempted = true;
    try {
      const msgId = await channel.sendMessage(chatJid, text);
      if (typeof msgId === 'string') lastFinalMsgId = msgId;
      deliveredPlainFallback = true;
      outputSentToUser = true;
      turnFinalized = true;
      logger.warn(
        { chatJid, group: group.name, endPath, delivered: true, length: text.length },
        'native streaming reply delivered via plain terminal fallback',
      );
      return true;
    } catch (err) {
      logger.warn(
        { chatJid, group: group.name, endPath, delivered: false, err: (err as Error).message },
        'native streaming plain terminal fallback failed',
      );
      return false;
    }
  };

  /**
   * Terminalize one logical user turn. This is deliberately reusable: the
   * first query returns through processGroupMessages(), while follow-up IPC
   * queries keep using this onOutput closure after that promise has resolved.
   * Every query-complete signal must therefore run the same delivery state
   * machine, with the outer try-tail/finally serving only as safety nets.
   */
  const finalizeNativeStreamTerminal = async (endPath: string): Promise<boolean> => {
    if (streamDiedCoalesced && streamDiedCoalesced.length > 0) {
      const combined = streamDiedCoalesced.join('\n\n');
      const landed = await sendPlainTerminal(combined, `${endPath}-coalesced-final`);
      streamDiedCoalesced = undefined;
      if (!landed) streamDeliveryFailed = true;
    }

    if (streamDeliveryFailed && !deliveredPlainFallback) {
      const landed = await sendPlainTerminal(streamFailureFinalText, `${endPath}-end-total-failure`);
      if (landed) streamDeliveryFailed = false;
    }

    await settleAndProbeWireDeath(`${endPath}-settle`);
    const nativeStreamNeedsPartialFallback =
      !streamDeliveryFailed && (streamDiedCoalesced !== undefined || streamHandle?.isCancelled?.() === true);
    if (nativeStreamNeedsPartialFallback && !deliveredPlainFallback && progressiveText.trim().length > 0) {
      const landed = await sendPlainTerminal(progressiveText, `${endPath}-partial-wire-death`);
      if (!landed) streamDeliveryFailed = true;
    }

    // A query can terminate after cumulative partials without a separate
    // non-partial final (runner error/edge provider sequence). If the wire is
    // still healthy, finalize that same stream instead of explicit-cancelling
    // it and making the visible draft disappear. Wire-dead handles were
    // nulled by probeWireDeath above and already took the plain path.
    if (streamHandle && !outputSentToUser && progressiveText.trim().length > 0) {
      const activeHandle = streamHandle;
      streamHandle = undefined;
      try {
        const msgId = await activeHandle.end(progressiveText);
        if (activeHandle.endFailed?.() === true) {
          streamDeliveryFailed = true;
          streamFailureFinalText = progressiveText;
          const landed = await sendPlainTerminal(progressiveText, `${endPath}-partial-final-total-failure`);
          if (landed) streamDeliveryFailed = false;
        } else {
          if (typeof msgId === 'string') lastFinalMsgId = msgId;
          outputSentToUser = true;
          turnFinalized = true;
          logger.info(
            { chatJid, group: group.name, endPath: `${endPath}-partial-final`, delivered: true },
            'native streaming unfinished partial finalized at query terminal',
          );
        }
      } catch (err) {
        streamDeliveryFailed = true;
        streamFailureFinalText = progressiveText;
        logger.warn(
          { chatJid, group: group.name, endPath: `${endPath}-partial-final`, err: (err as Error).message },
          'native streaming partial finalization threw; using plain terminal fallback',
        );
        const landed = await sendPlainTerminal(progressiveText, `${endPath}-partial-final-throw`);
        if (landed) streamDeliveryFailed = false;
      }
    }

    // A healthy unfinished stream with no answer text is cleanup-only.
    if (streamHandle) {
      try {
        await streamHandle.cancel();
      } catch (err) {
        logger.warn(
          { chatJid, group: group.name, endPath: `${endPath}-cancel`, err: (err as Error).message },
          'streamHandle.cancel at query terminal failed (non-fatal)',
        );
      }
      streamHandle = undefined;
    }

    const failed = streamDeliveryFailed || (terminalPlainAttempted && !deliveredPlainFallback);
    if (failed && !terminalFailureHandled) {
      terminalFailureHandled = true;
      const isFollowUp = queue.getUserTurnSeq(chatJid) > initialUserTurnSeq;
      if (isFollowUp) {
        const rollbackCursor = queue.requestDeliveryRetry(chatJid);
        if (rollbackCursor !== null) {
          const before = lastAgentTimestamp[chatJid];
          lastAgentTimestamp[chatJid] = rollbackCursor;
          saveState();
          logger.warn(
            { chatJid, group: group.name, endPath, before, rolledBackTo: rollbackCursor },
            'follow-up terminal delivery failed; rolled back current turn and queued retry',
          );
        }
      } else {
        // Initial query: processGroupMessages' normal hadError path returns
        // false to GroupQueue, which schedules the existing bounded retry.
        hadError = true;
      }
      return false;
    }

    if (outputSentToUser || deliveredPlainFallback) {
      queue.notifyUserDelivery(chatJid);
    }
    return !failed;
  };
  // Progress-draft lane (proposal docs/proposals/2026-05-23-progress-drafts.md).
  // Lazily created on the first `status==='progress'` event when the channel
  // is configured `streaming.mode === 'progress'`. Independent of the
  // thinking + answer lanes. Reset on every turn boundary along with them.
  let progressDraft: ProgressDraftSession | undefined;
  const channelForProgress: import('./types-extensions.js').Channel = channel;
  const progressStreamingCfg = resolveProgressStreamingForChat(channelForProgress.name, chatJid);
  function ensureProgressDraft(): ProgressDraftSession | undefined {
    if (progressStreamingCfg.mode !== 'progress') return undefined;
    if (!channelForProgress.editMessage) return undefined; // transport requires edit
    if (!progressDraft) {
      progressDraft = createProgressDraftSession({
        transport: createProgressTransport({ channel: channelForProgress, chatJid }),
        options: progressStreamingCfg.options,
        onError: (err, ctx) =>
          logger.warn(
            { chatJid, channel: channelForProgress.name, stage: ctx.stage, err: err.message },
            'progress-draft: stage error (non-fatal)',
          ),
      });
    }
    return progressDraft;
  }
  async function finalizeProgressDraft(finalText: string): Promise<void> {
    if (!progressDraft) return;
    try {
      await progressDraft.finalize(finalText);
    } catch (err) {
      logger.warn({ chatJid, err: (err as Error).message }, 'progress-draft: finalize threw (non-fatal)');
    }
    progressDraft = undefined;
  }
  function abandonProgressDraft(): void {
    if (!progressDraft) return;
    try {
      progressDraft.abandon();
    } catch (err) {
      logger.warn({ chatJid, err: (err as Error).message }, 'progress-draft: abandon threw (non-fatal)');
    }
    progressDraft = undefined;
  }
  // IPC mode: the runAgent() promise resolves on the first query-complete
  // signal, but the spawned agent process keeps living and the stdout
  // listener (with this onOutput closure) keeps firing for follow-up
  // turns piped via queue.sendMessage. Track query boundaries so each
  // new turn starts with fresh progressive/multi-final state instead
  // of editing turn N-1's reply when turn N's output arrives.
  // Symptom this prevents (kenansun, 2026-04-21): user asks new
  // question, nanoclaw edits the previous reply instead of sending a
  // new message. Root cause: lastFinalMsgId from turn N-1 still in scope.
  // Two flags so the thinking branch and result branch each reset their
  // own per-turn state once. We tried sharing a single flag (commit 877383e)
  // but consuming it in the thinking branch caused the result branch to
  // skip its reset of progressiveMsgId/lastFinalMsgId, which made a new
  // turn edit the previous reply (kenan TG repro 2026-04-25 22:41).
  let queryBoundaryPendingThinking = false;
  let queryBoundaryPendingResult = false;
  // Independent turn-boundary signal sourced from GroupQueue. The GHC
  // runner emits query-complete after every query, but userTurnSeq is still
  // the authoritative *start* boundary: it advances before the first output
  // of every initial/follow-up turn and protects state reset if a runner ever
  // omits or delays its terminal sentinel.
  let lastUserTurnSeqSeen = initialUserTurnSeq;
  // True after a result.result with !partial fires for the current turn.
  // Any further thinking / reasoning_delta events that arrive before a new
  // turn boundary (userTurnSeq advance OR sentinel) are SDK trailing-delta
  // artifacts that must be ignored — otherwise they open orphan thinking
  // bubbles AFTER the answer was already finalized (kenan TG repro
  // 2026-04-26 00:03: thinking bubble appeared post-answer).
  let turnFinalized = false;
  let deliveryStateTurnSeq = initialUserTurnSeq;
  const resetDeliveryStateForTurn = (seq: number): void => {
    if (seq === deliveryStateTurnSeq) return;
    deliveryStateTurnSeq = seq;
    hadError = false;
    outputSentToUser = false;
    deliveredPlainFallback = false;
    terminalPlainAttempted = false;
    terminalFailureHandled = false;
    streamDeliveryFailed = false;
    streamFailureFinalText = '';
    progressiveMsgId = undefined;
    progressiveText = '';
    lastFinalMsgId = undefined;
    streamDiedCoalesced = undefined;
    turnFinalized = false;
  };
  // Native reasoning=on extension (PR #53 phase B commit 2): when channel
  // supportsNativeThinking AND mode === 'on', stream the thinking text
  // through the same streamHandle as a cumulative `<formatted-thinking>\n\n<answer>`
  // prefix. Frozen on the first answer chunk so trailing reasoning_delta
  // doesn't regress the bubble (case (q) from the proposal).
  let nativeOnThinkingPrefix: string | undefined;
  let nativeOnThinkingFrozen = false;
  // Thinking message state (separate from answer progressive message)

  try {
    const output = await runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        // Streaming output callback. Reset delivery gates at the first event
        // of every new userTurnSeq, regardless of event kind (thinking,
        // progress, result). The query-complete sentinel itself must keep the
        // current turn's state until terminalization finishes.
        const isQueryComplete = result.result === null && (result as any).newSessionId && !result.partial;
        if (!isQueryComplete) {
          resetDeliveryStateForTurn(queue.getUserTurnSeq(chatJid));
        }

        // Query-complete sentinel: agent finished a query and is waiting for
        // the next IPC pipe (IPC mode only). Mark a boundary so the next
        // non-null result resets per-turn message-id state. Doing the reset
        // here (on the sentinel) instead of pre-emptively at the top of the
        // next turn avoids racing with trailing partials of the current turn.
        if (isQueryComplete) {
          // The GHC runner emits this after EVERY query, including IPC
          // follow-ups. Terminalize here because processGroupMessages' outer
          // try-tail/finally runs only for the first query of a long-lived
          // host process; later turns keep using this callback closure.
          await finalizeNativeStreamTerminal('query-complete');
          queryBoundaryPendingThinking = true;
          queryBoundaryPendingResult = true;
          // Don't return — let the rest of the handler run for thinking/status
          // bookkeeping, then exit naturally on the !result.result guard above.
        }

        // Progress-draft lane: tool-call lifecycle from the runner. Routed
        // here independent of thinking/answer. Gated by per-channel
        // `streaming.mode === 'progress'`. See proposal
        // docs/proposals/2026-05-23-progress-drafts.md.
        if (result.status === 'progress' && result.progress) {
          const draft = ensureProgressDraft();
          if (draft) {
            try {
              draft.apply(result.progress);
            } catch (err) {
              logger.warn({ chatJid, err: (err as Error).message }, 'progress-draft: apply threw (non-fatal)');
            }
          }
          return;
        }

        // Thinking-only deltas (no result yet). Modes:
        //   `flash` -> stream a compact one-line preview into `thinkingMsgId`;
        //             deleted/cleared on first answer chunk.
        //   `on`    -> stream the full thinking text into `thinkingMsgId`;
        //             kept visible above the answer (separate message).
        //   `off`   -> drop the delta; final result will not include thinking.
        if (result.thinking && !result.result) {
          // Drop trailing reasoning_delta events that arrive AFTER the turn's
          // final answer was already sent (and before any new-turn boundary).
          if (turnFinalized) {
            const seqNow = queue.getUserTurnSeq(chatJid);
            if (seqNow === lastUserTurnSeqSeen) {
              return;
            }
            // New turn started — fall through; the seq-check below will
            // reset state.
          }
          // Reliable per-turn boundary check (see comment in result.result
          // branch below): if userTurnSeq advanced, this delta belongs to a
          // new turn — set the thinking pending flag so the boundary block
          // below resets thinkingMsgId / opening lock.
          const currentSeq = queue.getUserTurnSeq(chatJid);
          if (currentSeq !== lastUserTurnSeqSeen) {
            resetDeliveryStateForTurn(currentSeq);
            lastUserTurnSeqSeen = currentSeq;
            queryBoundaryPendingThinking = true;
            queryBoundaryPendingResult = true;
            turnFinalized = false;
          }
          const thinkingMode = normalizeShowThinking(
            getEffectiveShowThinking(chatJid) ?? getConfig().agents?.defaults?.showThinking,
          );
          const streamThinking = thinkingMode === 'flash' && !!channel.editMessage && !channel.usesNativeStreaming;
          // Native thinking path (Teams via TeamsStreamingSession): flash
          // mode streams reasoning_delta through the native StreamHandle
          // using the appendThinking/commitAnswer phase machine, instead
          // of the legacy sendMessage(thinkingMsgId) + editMessage path.
          // Gated by the channel cap so non-Teams channels are unaffected.
          // See proposal docs/proposals/2026-05-21-teams-thinking-phase-B.md
          const nativeThinking =
            thinkingMode === 'flash' && !!channel.supportsNativeThinking && !!channel.streamMessage;
          if (nativeThinking && !flashThinkingDismissed) {
            // Boundary handling parallels the legacy flash branch: a new
            // turn must clear thinkingMsgId/lastThinkingRendered AND
            // cancel any leftover streamHandle so a fresh stream opens.
            if (queryBoundaryPendingThinking) {
              queryBoundaryPendingThinking = false;
              thinkingMsgId = undefined;
              flashThinkingDismissed = false;
              lastThinkingRendered = undefined;
              thinkingPrependedThisQuery = false;
              nativeOnThinkingPrefix = undefined;
              nativeOnThinkingFrozen = false;
              flashOpeningLock.reset();
              flashEditCoalescer.clear();
              if (streamHandle) {
                try {
                  await streamHandle.cancel();
                } catch (err) {
                  logger.warn(
                    { chatJid, err: (err as Error).message },
                    'native-thinking: streamHandle.cancel during turn boundary failed (non-fatal)',
                  );
                }
                streamHandle = undefined;
              }
            }
            const tp = formatThinkingForFlash(result.thinking, chatJid);
            if (tp) {
              // Avoid no-op repeats: TeamsStreamingSession dedupes via
              // _lastSent, but skipping early saves a sender allocation.
              if (lastThinkingRendered !== tp.text) {
                const sendOpts = tp.parseMode ? { parseMode: tp.parseMode } : undefined;
                if (!streamHandle) {
                  // Don't toggle typing off here — streamMessage owns the
                  // typing lifecycle via its informative bootstrap activity
                  // (Nit 1 from VM review on 3cfd021). Toggling false then
                  // having the informative chunk re-enable causes a visible
                  // typing indicator flicker in the Teams client.
                  streamHandle = await channel.streamMessage!(chatJid, sendOpts);
                }
                // The appendThinking method is only present when the
                // channel sets supportsNativeThinking; gate confirmed
                // above so the cast is safe.
                const handle = streamHandle as import('./types-extensions.js').NativeThinkingStreamHandle;
                if (handle.appendThinking) {
                  await handle.appendThinking(tp.text);
                  lastThinkingRendered = tp.text;
                  // Bug 2 probe: wire can die during the thinking phase
                  // before any text `chunk()` lands. Without this probe
                  // the coalesce buffer would never arm and a subsequent
                  // multi-final turn would still fan out.
                  probeWireDeath('appendThinking');
                }
              }
            }
            return;
          }
          // Native thinking path for reasoning=on (single-stream cumulative
          // prefix `<formatted-thinking>\n\n<answer>`, no commitAnswer here).
          // Each reasoning_delta updates `nativeOnThinkingPrefix`; the
          // partial answer branch downstream concatenates it before the
          // answer text. Frozen on the first answer chunk via
          // `nativeOnThinkingFrozen` so trailing reasoning_delta after the
          // answer starts cannot regress the bubble (case (q)).
          if (
            thinkingMode === 'on' &&
            channel.supportsNativeThinking &&
            channel.streamMessage &&
            !nativeOnThinkingFrozen
          ) {
            const tp = formatThinkingForChannel(result.thinking, chatJid);
            if (tp) {
              nativeOnThinkingPrefix = tp.text;
              // Live-render the thinking text in the streaming bubble.
              if (!streamHandle) {
                streamHandle = await channel.streamMessage(chatJid, undefined);
              }
              await streamHandle.chunk(tp.text);
              lastThinkingRendered = tp.text;
              // Bug 2 probe: same reason as the appendThinking site above
              // (reasoning=on path streams thinking-prefix through chunk()
              // before any answer chunks arrive).
              probeWireDeath('native-on-thinking-chunk');
            }
            return;
          }
          // In flash mode, once we've dismissed the thinking preview on the
          // first answer chunk, ignore trailing reasoning_delta events for
          // the rest of the turn (don't re-open it).
          if (streamThinking && channel.editMessage && !(thinkingMode === 'flash' && flashThinkingDismissed)) {
            // Boundary handling: a new query (queryBoundaryPending=true)
            // means a fresh turn — drop the previous turn's thinking
            // pointer so this turn opens a new one.
            if (queryBoundaryPendingThinking) {
              // Consume the thinking-side sentinel exactly once per turn so
              // subsequent reasoning_delta frames don't re-wipe thinkingMsgId
              // (kenan TG repro 2026-04-25 21:55 — 7 frames produced 7 sends).
              // The result-side sentinel is a separate flag and is consumed
              // in the result.result branch below; that branch still needs
              // to reset progressiveMsgId/lastFinalMsgId for the new turn.
              queryBoundaryPendingThinking = false;
              thinkingMsgId = undefined;
              flashThinkingDismissed = false;
              lastThinkingRendered = undefined;
              thinkingPrependedThisQuery = false;
              flashOpeningLock.reset();
              flashEditCoalescer.clear();
            }
            const tp = formatThinkingForFlash(result.thinking, chatJid);
            if (tp) {
              const sendOpts = tp.parseMode ? { parseMode: tp.parseMode } : undefined;
              if (!thinkingMsgId) {
                // Opening lock: openOnce() either runs sendMessage (if we're
                // first) or awaits the in-flight opener (if a sibling delta
                // beat us). After it resolves, thinkingMsgId is set and the
                // late delta falls through to the coalescer enqueue branch.
                await flashOpeningLock.openOnce(async () => {
                  await traceSetTyping(channel, chatJid, false, 'thinking-first');
                  const desired = tp.text + ' ◌';
                  const msgId = await channel.sendMessage(chatJid, desired, sendOpts);
                  thinkingMsgId = typeof msgId === 'string' ? msgId : undefined;
                  lastThinkingRendered = desired;
                });
                if (thinkingMsgId) {
                  // Late-waiter path: our text may differ from what the
                  // first sender just sent. Skip the enqueue if it's the
                  // exact same text (rpi5 review 2026-04-25: avoid the
                  // first-frame no-op edit). lastThinkingRendered tracks
                  // the most recent text we rendered for this msgId.
                  const desired = tp.text + ' ◌';
                  if (lastThinkingRendered !== desired) {
                    flashEditCoalescer.enqueue(thinkingMsgId, desired, sendOpts);
                    lastThinkingRendered = desired;
                  }
                }
              } else {
                // Coalescer path: enqueue the latest text instead of
                // awaiting editMessage directly. This caps in-flight edits at
                // one per msgId, drops intermediate frames automatically, and
                // detects + cleans up the editMessage→sendMessage fallback
                // orphan instead of letting it stay on screen as a duplicate.
                // (kenan TG repro 2026-04-25 00:35: long thinking text in
                // flash mode produced N orphan thinking bubbles.)
                const desired = tp.text + ' ◌';
                if (lastThinkingRendered !== desired) {
                  flashEditCoalescer.enqueue(thinkingMsgId, desired, sendOpts);
                  lastThinkingRendered = desired;
                }
              }
            }
          }
          return;
        }

        if (result.result) {
          // Reliable per-turn boundary: if the queue advanced its turn seq
          // since we last looked (a new user message was piped), treat this
          // as a new turn even if no SDK sentinel fired.
          const currentSeq = queue.getUserTurnSeq(chatJid);
          if (currentSeq !== lastUserTurnSeqSeen) {
            resetDeliveryStateForTurn(currentSeq);
            lastUserTurnSeqSeen = currentSeq;
            queryBoundaryPendingResult = true;
            queryBoundaryPendingThinking = true;
            turnFinalized = false;
          }
          // New-turn boundary: clear per-turn message tracking before handling
          // this output so it sends fresh instead of editing the previous turn.
          if (queryBoundaryPendingResult) {
            queryBoundaryPendingResult = false;
            progressiveMsgId = undefined;
            progressiveText = '';
            lastFinalMsgId = undefined;
            outputSentToUser = false;
            // Progress-draft lane: a leftover open draft from the previous
            // turn is no longer relevant. Abandon (no wire traffic) so the
            // next turn opens a fresh draft when its first tool event fires.
            abandonProgressDraft();
            // NOTE: thinking-side state (thinkingMsgId, flashThinkingDismissed,
            // lastThinkingRendered, flashOpeningLock, flashEditCoalescer,
            // thinkingPrependedThisQuery) is intentionally NOT reset here.
            // The thinking-branch boundary owns those fields and resets them
            // on its own turn-advance. If we cleared thinkingMsgId here, the
            // current-turn flash thinking bubble (opened by thinking-branch
            // earlier in this same turn) would be orphaned: the dismiss code
            // below relies on thinkingMsgId being defined to delete the
            // bubble at finalize. (kenan TG repro 2026-04-26 00:20: thinking
            // bubble at 16:20:45 was never deleted because the result-branch
            // reset at 16:20:59 nulled thinkingMsgId before final-output ran.)
            // Cancel any leftover native stream from the previous turn so
            // the next turn opens a fresh stream. cancel() is idempotent.
            if (streamHandle) {
              try {
                await streamHandle.cancel();
              } catch (err) {
                logger.warn(
                  { chatJid, err: (err as Error).message },
                  'streamHandle.cancel during turn boundary failed (non-fatal)',
                );
              }
              streamHandle = undefined;
            }
            logger.debug({ chatJid, group: group.name }, 'IPC turn boundary: reset per-turn message-id state');
          }
          // Mode behavior on first answer event:
          //   `on`    -> prepend thinking to result.result as ONE message
          //              (legacy behavior, restored 2026-04-25 after PR #27
          //              regression — the per-delta streaming path is too
          //              fragile for long thinking text and produced N
          //              orphan bubbles when editMessage hit any failure).
          //   `flash` -> delete thinkingMsgId (or edit to a single space if
          //              channel lacks deleteMessage). Set flashThinkingDismissed
          //              so trailing reasoning_delta events don't re-open it.
          //   `off`   -> nothing to do.
          let thinkingParseMode: 'HTML' | 'Markdown' | undefined;
          const thinkingMode = normalizeShowThinking(
            getEffectiveShowThinking(chatJid) ?? getConfig().agents?.defaults?.showThinking,
          );
          if (result.thinking && !result.partial && thinkingMode === 'on' && !thinkingPrependedThisQuery) {
            const tp = formatThinkingForChannel(result.thinking, chatJid);
            const merged = applyOnModeThinkingPrepend({
              thinking: result.thinking,
              resultText: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
              alreadyPrepended: thinkingPrependedThisQuery,
              formatted: tp,
            });
            if (merged.prepended) {
              thinkingParseMode = merged.parseMode;
              result.result = merged.resultText;
              thinkingPrependedThisQuery = true;
            }
          }
          // Native thinking dismiss (Teams flash): the active streamHandle
          // is in `thinking` phase from earlier reasoning_delta events. Flip
          // it to `answer` phase via commitAnswer() so the next chunk()
          // (right below in the result.partial branch) overwrites the
          // thinking text in the same client-side bubble. Idempotent on
          // repeat calls, so we don't gate on flashThinkingDismissed here —
          // commitAnswer() itself no-ops once already flipped.
          if (!flashThinkingDismissed && thinkingMode === 'flash' && channel.supportsNativeThinking && streamHandle) {
            const handle = streamHandle as import('./types-extensions.js').NativeThinkingStreamHandle;
            if (handle.commitAnswer) {
              try {
                handle.commitAnswer();
              } catch (err) {
                logger.warn(
                  { chatJid, err: (err as Error).message },
                  'native-thinking: commitAnswer failed (non-fatal)',
                );
              }
            }
            flashThinkingDismissed = true;
          }
          if (thinkingMsgId && thinkingMode === 'flash' && !flashThinkingDismissed) {
            // Drain coalescer first: a pending edit on this msgId would
            // race with the delete (delete succeeds → edit hits a deleted
            // msg → logs warn, harmless but noisy). Also remove the slot so
            // any trailing reasoning_delta that sneaks past the
            // flashThinkingDismissed gate is a no-op.
            await flashEditCoalescer.drain(thinkingMsgId);
            // Flash spec (kenan 2026-04-24): "thinking 内容删掉".
            // Try deleteMessage first; fall back to editing to a single
            // space (channels reject empty text) if the channel doesn't
            // expose deleteMessage. Better than the prior behavior of
            // leaving the full thinking preview visible.
            try {
              if (channel.deleteMessage) {
                await channel.deleteMessage(chatJid, thinkingMsgId);
              } else if (channel.editMessage) {
                await channel.editMessage(chatJid, thinkingMsgId, ' ');
              }
            } catch (err) {
              logger.warn({ chatJid, err: (err as Error).message }, 'flash thinking dismiss failed (non-fatal)');
            }
            thinkingMsgId = undefined;
            flashThinkingDismissed = true;
          }
          // (`on` mode now merges thinking into result.result above; the
          //  streamed-thinking-message design from PR #27 was reverted on
          //  2026-04-25 after producing orphan-bubble regression on TG.)
          const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          if (!text) {
            if (result.status === 'success') queue.notifyIdle(chatJid);
            return;
          }

          // Agent produced output for the user — reset busy-ack debounce so any
          // future silent stretch on a follow-up message can be acked again.
          queue.notifyAgentOutput(chatJid);

          const sendOpts = thinkingParseMode ? { parseMode: thinkingParseMode } : undefined;

          if (result.partial && channel.usesNativeStreaming && channel.streamMessage) {
            // Native streaming path: hand cumulative text to the channel's
            // StreamHandle. The handle is responsible for serializing
            // outbound activities and graceful degradation on platforms
            // that reject mid-stream. We never call sendMessage/editMessage
            // here, so updateActivity races (the partial+final duplicate
            // bug) cannot occur on this path.
            //
            // reasoning=on extension (PR #53 commit 2): if the channel
            // supports native thinking AND there's a live thinking prefix,
            // freeze it (case (q): trailing reasoning_delta after first
            // answer chunk MUST NOT regress) and prepend so the streamed
            // bubble shows `<formatted-thinking>\n\n<answer>` cumulatively.
            let chunkText = text;
            if (thinkingMode === 'on' && channel.supportsNativeThinking && nativeOnThinkingPrefix) {
              nativeOnThinkingFrozen = true;
              chunkText = `${nativeOnThinkingPrefix}\n\n${text}`;
            }
            progressiveText = chunkText;
            if (!streamHandle) {
              await traceSetTyping(channel, chatJid, false, 'native-stream-open');
              streamHandle = await channel.streamMessage(chatJid, sendOpts);
            }
            await streamHandle.chunk(chunkText);
            // Bug 2 probe: chunk() noops silently once the wire is cancelled
            // (see StreamHandle contract). Arming the coalesce buffer here
            // ensures subsequent finals don't fan out into separate
            // `channel.sendMessage` calls. Same helper covers the two
            // thinking-phase entry points above.
            probeWireDeath('answer-chunk');
          } else if (result.partial && channel.editMessage) {
            // Delta/partial: accumulate and edit existing message.
            progressiveText = text; // delta buffer already accumulated in agent-runner
            if (!progressiveMsgId) {
              // First partial — send new message
              await traceSetTyping(channel, chatJid, false, 'progressive-first-partial');
              const msgId = await channel.sendMessage(chatJid, text + ' ◌', sendOpts);
              progressiveMsgId = typeof msgId === 'string' ? msgId : undefined;
            } else {
              // Subsequent partial — edit existing message. Capture id in
              // case editMessage falls back to a fresh sendMessage (returns
              // a new id) so we keep editing the live message instead of
              // spawning duplicates. (kenan TG repro 2026-04-24)
              const editedId = await channel.editMessage(chatJid, progressiveMsgId, text + ' ◌', sendOpts);
              if (typeof editedId === 'string' && editedId !== progressiveMsgId) {
                progressiveMsgId = editedId;
              }
            }
          } else {
            // Final message (or channel doesn't support edit)
            await traceSetTyping(channel, chatJid, false, 'final-output');
            if (streamDiedCoalesced !== undefined) {
              // Bug 2 fallback: streaming wire died earlier this turn.
              // Buffer this final and let the flush at turn-end publish
              // a single concatenated message instead of N bubbles.
              streamDiedCoalesced.push(text);
              turnFinalized = true;
              progressiveMsgId = undefined;
              progressiveText = '';
              void finalizeProgressDraft(text);
              await armTypingBounded(channel, chatJid, 'after-coalesced-final', INTERIM_TYPING_TTL_MS);
              logger.info(
                { group: group.name, buffered: streamDiedCoalesced.length },
                `Agent output (coalesced): ${raw.length} chars`,
              );
              return;
            }
            if (streamHandle) {
              // Native streaming path: close the stream with the final text.
              // The handle owns whether this becomes a new message or replaces
              // the in-flight stream bubble (Teams: replaces; others: TBD).
              const activeHandle = streamHandle;
              const msgId = await activeHandle.end(text);
              streamHandle = undefined;
              lastFinalMsgId = typeof msgId === 'string' ? msgId : undefined;
              // A2 (2026-08-03): the streaming session degrades to a plain
              // message on wire reject, but if EVERY publish attempt failed
              // (streaming final + last-ditch plain both rejected) the reply
              // did NOT land. Without this, the tail below unconditionally
              // sets outputSentToUser=true + turnFinalized=true, so the turn
              // is marked delivered, the cursor advances, and the answer is
              // silently lost with no retry (kenan Teams repro 2026-08-03).
              // A2 = signal only here: flag the failure and stash the final
              // text; the single delivery attempt + cursor decision happens
              // in ONE place (deliverStreamFailureFallback, run after the
              // output loop) so there is exactly one send path and no
              // double-send.
              if (activeHandle.endFailed?.() === true) {
                streamDeliveryFailed = true;
                streamFailureFinalText = text;
                progressiveMsgId = undefined;
                logger.warn(
                  { chatJid, group: group.name },
                  'native streaming end() failed to deliver; deferring to single plain fallback + cursor decision',
                );
                await armTypingBounded(channel, chatJid, 'after-failed-final', INTERIM_TYPING_TTL_MS);
                return;
              }
            } else if (progressiveMsgId && channel.editMessage) {
              // Replace the progressive message with final content. Capture
              // the (possibly new) id from the editMessage fallback path so
              // lastFinalMsgId tracks the actual visible message.
              const editedId = await channel.editMessage(chatJid, progressiveMsgId, text, sendOpts);
              if (typeof editedId === 'string') {
                lastFinalMsgId = editedId;
              }
            } else if (
              outputSentToUser &&
              lastFinalMsgId &&
              channel.editMessage &&
              !channel.prefersNewMessageForFinal
            ) {
              // Multiple final outputs (e.g. tool call → new response): edit the
              // last message on channels where in-place edits feel natural
              // (Telegram). Channels with prefersNewMessageForFinal (Teams)
              // skip this branch and send a new message instead, otherwise
              // each subsequent final silently overwrites the previous one.
              const editedId = await channel.editMessage(chatJid, lastFinalMsgId, text, sendOpts);
              if (typeof editedId === 'string' && editedId !== lastFinalMsgId) {
                lastFinalMsgId = editedId;
              }
            } else {
              try {
                const msgId = await channel.sendMessage(chatJid, text, sendOpts);
                lastFinalMsgId = typeof msgId === 'string' ? msgId : undefined;
              } catch (err) {
                if (!channel.usesNativeStreaming) throw err;
                streamDeliveryFailed = true;
                streamFailureFinalText = text;
                logger.warn(
                  { chatJid, group: group.name, endPath: 'direct-final', err: (err as Error).message },
                  'native-streaming channel direct final failed; deferring to terminal retry decision',
                );
                return;
              }
            }
            progressiveMsgId = undefined;
            progressiveText = '';
            outputSentToUser = true;
            // Progress draft (proposal docs/proposals/2026-05-23-progress-drafts.md):
            // turn produced a real final answer. Finalize the draft so the
            // bubble flips to its summary (✅ N done / ❌ M failed). V1
            // forces finalizePolicy='release' in streaming-config, so we
            // pass the answer text only for future edit-in-place phases.
            void finalizeProgressDraft(text);
            // Mark this turn finalized; any further reasoning_delta events
            // arriving before a new userTurnSeq are SDK trailing artifacts
            // and must be ignored to avoid orphan thinking bubbles.
            turnFinalized = true;
            // Re-arm typing keepalive after sending an interim final-output
            // message, but as a *bounded* pulse: if no further output
            // arrives within TTL ms, auto-clear so we don't show 'typing
            // forever' on the last final (turn-end may not run for many
            // seconds while the runner drains its idle window).
            // Any subsequent traceSetTyping (next thinking, next final,
            // turn-end, finally-guard) cancels the pending auto-clear.
            // (kenan Teams repro 2026-04-27 — 'always typing' regression
            //  after the unbounded re-arm in 18daa61.)
            await armTypingBounded(channel, chatJid, 'after-interim-final', INTERIM_TYPING_TTL_MS);
          }
          logger.info({ group: group.name, partial: !!result.partial }, `Agent output: ${raw.length} chars`);
        }

        if (result.status === 'success') {
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
      triggeringUserId,
    );

    // Idempotent safety call: query-complete normally terminalized already;
    // the shared attempt/failure gates and cleared handle make repeats no-ops.
    await finalizeNativeStreamTerminal('process-tail');

    await traceSetTyping(channel, chatJid, false, 'turn-end');

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor —
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
      return false;
    }

    return true;
  } finally {
    // Safety net for the first query. Follow-up IPC turns terminalize from the
    // per-query sentinel above because this outer finally has already run.
    await finalizeNativeStreamTerminal('finally-guard');
    // Progress draft: any draft still open at finally-guard time means the
    // turn ended without a normal final-output path (error, cancel, etc).
    // Abandon without wire traffic; caller's error path owns any user-visible
    // cleanup.
    abandonProgressDraft();
    await traceSetTyping(channel, chatJid, false, 'finally-guard');
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  triggeringUserId?: string,
): Promise<'success' | 'error'> {
  // v2-only (PR #49): is-this-the-default-agent decision point. The
  // boolean flows into RunnerInput.isDefaultAgent (→ container mount layout,
  // mount-security.validateMount, host-runner template path) and the
  // tasks/groups snapshot writers.
  const isDefaultAgent = folderIsDefaultAgent(group.folder) === true;
  // Operator = default-agent OR owner. Owner chatting from a
  // non-default-agent folder (e.g. a Teams DM whose folder != 'main')
  // must still see all tasks in `list_tasks`, matching the owner view
  // `/tasks` already grants (src/slash-commands.ts) and the owner-override
  // the write-path IPC gates already apply (src/ipc.ts processTaskIpc).
  // isOwner() reads user_roles; only the host can call it, so we resolve
  // the flag here and thread it through the snapshot + ContainerInput.
  const isOperator = isDefaultAgent || (triggeringUserId ? isOwner(triggeringUserId) : false);
  const agent = resolveAgentForChat(chatJid);
  const provider = getAgentProvider(agent);
  const sessionId = sessions[group.folder]?.[provider];

  // Update tasks snapshot for container to read (filtered by operator scope)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isOperator,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      kind: t.kind,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isDefaultAgent, availableGroups, new Set(Object.keys(registeredGroups)));

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (!sessions[group.folder]) sessions[group.folder] = {};
          sessions[group.folder][provider] = output.newSessionId;
          setSession(group.folder, output.newSessionId, provider);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runAgentForChat(
      chatJid,
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isDefaultAgent: isDefaultAgent,
        isOperator,
        triggeringUserId,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (!sessions[group.folder]) sessions[group.folder] = {};
      sessions[group.folder][provider] = output.newSessionId;
      setSession(group.folder, output.newSessionId, provider);
    }

    // Mark idle-waiting so GroupQueue keeps process alive for IPC reuse
    if (output.status === 'success') {
      queue.markIdle(chatJid);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId && output.error && /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(output.error);

      if (isStaleSession) {
        logger.warn(
          {
            group: group.name,
            provider,
            staleSessionId: sessionId,
            error: output.error,
          },
          'Stale session detected — clearing for next retry',
        );
        if (sessions[group.folder]) delete sessions[group.folder][provider];
        deleteSession(group.folder, provider);
      }

      logger.error({ group: group.name, error: output.error }, 'Container agent error');

      // Send error feedback to user (if enabled and not shutting down)
      const sendErrors = getConfig().sendErrorToUser === true;
      if (sendErrors && !queue.isShuttingDown()) {
        try {
          const errMsg = output.error || 'Unknown error';
          let userMessage = '\u26a0\ufe0f Unable to process your message.';
          if (errMsg.includes('docker') || errMsg.includes('Docker')) {
            userMessage += ' Docker is not running or not installed. Run "nanoclaw doctor" to check.';
          } else if (errMsg.includes('timeout')) {
            userMessage += ' The agent timed out processing your request.';
          } else if (errMsg.includes('ERR_MODULE_NOT_FOUND') || errMsg.includes('Cannot find package')) {
            userMessage +=
              ' Container image may be outdated or wrong provider. Run "nanoclaw sandbox build" to rebuild.';
          } else if (errMsg.includes('No authentication info') || errMsg.includes('not created with authentication')) {
            userMessage += ' Authentication failed. Check your GitHub token or API key configuration.';
          } else if (errMsg.includes('No such image') || errMsg.includes('image not found')) {
            userMessage += ' Container image not found. Run "nanoclaw sandbox build" to build it.';
          } else {
            userMessage += ' Error: ' + errMsg.slice(0, 200);
          }
          const errChannel = findChannel(channels, chatJid);
          if (errChannel) await errChannel.sendMessage(chatJid, userMessage);
        } catch {
          // best-effort
        }
      }

      return 'error';
    }

    return 'success';
  } catch (err: any) {
    logger.error({ group: group.name, err }, 'Agent error');

    // Send error feedback to user (if enabled and not shutting down)
    const sendErrors2 = getConfig().sendErrorToUser === true;
    if (sendErrors2 && !queue.isShuttingDown()) {
      try {
        const errMsg = err?.message || String(err);
        let userMessage = '\u26a0\ufe0f Unable to process your message.';
        if (errMsg.includes('docker') || errMsg.includes('ENOENT') || errMsg.includes('spawn')) {
          userMessage += ' Docker may not be running or installed. Run "nanoclaw doctor" to check.';
        } else if (errMsg.includes('timeout')) {
          userMessage += ' The agent timed out processing your request.';
        } else if (errMsg.includes('ERR_MODULE_NOT_FOUND') || errMsg.includes('Cannot find package')) {
          userMessage += ' Container image may be outdated or wrong provider. Run "nanoclaw sandbox build" to rebuild.';
        } else if (errMsg.includes('No authentication info') || errMsg.includes('not created with authentication')) {
          userMessage += ' Authentication failed. Check your GitHub token or API key configuration.';
        } else if (errMsg.includes('No such image') || errMsg.includes('image not found')) {
          userMessage += ' Container image not found. Run "nanoclaw sandbox build" to build it.';
        } else {
          userMessage += ` Error: ${errMsg.slice(0, 200)}`;
        }
        const errChannel = findChannel(channels, chatJid);
        if (errChannel) await errChannel.sendMessage(chatJid, userMessage);
      } catch {
        // best-effort
      }
    }

    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isDefaultAgentGroup = folderIsDefaultAgent(group.folder) === true;
          const needsTrigger = !isDefaultAgentGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          let messagesToSend = allPending.length > 0 ? allPending : groupMessages;

          // Handle slash commands in ALL pending messages, not just the last
          if (messagesToSend.length > 0) {
            const { normalizeSlashInput, handleSlashCommand } = await import('./slash-commands.js');
            const { parseChatJid } = await import('./shadow-inbound.js');
            const slashCtx2 = {
              chatJid,
              groupFolder: group.folder,
              channel: findChannel(channels, chatJid),
              clearSession: (folder: string) => delete sessions[folder],
              killActiveRunner: (jid: string) => queue.killActive(jid),
            };
            const nonSlash: typeof messagesToSend = [];
            // Bucket B (Step 3+4): see dispatch comment above. chatJid is
            // fixed for this batch; parse once (VM review nit).
            const parsedJid2 = parseChatJid(chatJid);
            for (const msg of messagesToSend) {
              const slashInput = normalizeSlashInput(msg.content);
              const senderId = parsedJid2 && msg.sender ? `${parsedJid2.channelType}:${msg.sender}` : undefined;
              const slashResult = await handleSlashCommand(slashInput, { ...slashCtx2, senderId });
              if (slashResult.handled) {
                lastAgentTimestamp[chatJid] = msg.timestamp;
              } else {
                nonSlash.push(msg);
              }
            }
            saveState();
            messagesToSend = nonSlash;
            if (messagesToSend.length === 0) continue;
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Include recent conversation context so GHC model has history
          const recentConversation = getRecentConversation(chatJid);
          const contextPrefix = formatConversationContext(
            recentConversation.slice(0, -messagesToSend.length), // exclude new messages
            TIMEZONE,
            ASSISTANT_NAME,
          );
          const fullPrompt = contextPrefix ? contextPrefix + '\n\n' + formatted : formatted;

          // Capture cursor BEFORE the optimistic advance so we can roll
          // back to it if the active agent dies before producing output
          // (host-runner SIGTERM, IPC pipe race, etc). Without rollback,
          // these messages are silently lost — they're already past the
          // cursor when the next agent spawn drains the DB.
          const cursorBeforePipe = lastAgentTimestamp[chatJid] || '';
          if (queue.sendMessage(chatJid, fullPrompt, cursorBeforePipe)) {
            logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
            lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            traceSetTyping(channel, chatJid, true, 'ipc-pipe').catch((err: any) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
            // Busy ack: if user piled on a 2nd message before the agent
            // produced anything, let them know we received it and are still
            // working. 1st message = typing indicator only; 3rd+ = silent.
            const ackDepth = queue.shouldSendBusyAck(chatJid);
            if (ackDepth !== null) {
              channel
                .sendMessage(chatJid, `📥 收到，正在处理上一条，这是第 ${ackDepth} 条，处理完会一起回复。`)
                ?.catch((err: any) => logger.warn({ chatJid, err }, 'Failed to send busy ack'));
            }
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err: any) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(chatJid, getOrRecoverCursor(chatJid), ASSISTANT_NAME, MAX_MESSAGES_PER_PROMPT);
    if (pending.length > 0) {
      logger.info({ group: group.name, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

let containerRuntimeAvailable = false;

function ensureContainerSystemRunning(): void {
  const config = getConfig();

  // Always cleanup orphaned containers, regardless of default mode.
  // Other agents might use sandbox even when default is host.
  // This matches upstream behavior where cleanupOrphans always runs.
  try {
    cleanupOrphans();
  } catch {
    // Container runtime might not be available — that’s OK for host-only setups
  }

  // Only check Docker runtime if any agent needs container mode
  const needsContainers =
    config.agents?.list?.some((a: any) => a.mode === 'sandbox') || config.agents?.defaults?.mode !== 'host';
  if (!needsContainers) {
    logger.info('No agents require containers — skipping runtime check');
    return;
  }
  try {
    ensureContainerRuntimeRunning();
    containerRuntimeAvailable = true;
    cleanupOrphans();
  } catch (err: any) {
    containerRuntimeAvailable = false;
    logger.warn(
      { err: err.message },
      'Container runtime not available. Service will start but message processing will fail. Run "nanoclaw doctor" to diagnose.',
    );
    console.warn('\n  \u26a0\ufe0f  WARNING: Docker is not running or not installed.');
    console.warn('  Messages will not be processed until Docker is available.');
    console.warn('  Run "nanoclaw doctor" to check your setup.\n');
  }
}

interface ThinkingFormat {
  text: string;
  parseMode?: 'HTML' | 'Markdown';
}

/**
 * Normalize the showThinking config value into the string enum used by
 * the dispatcher. Accepts legacy boolean shape (true=on, false=off) and
 * the new string enum ('on' | 'off' | 'flash').
 */
export function normalizeShowThinking(raw: boolean | 'on' | 'off' | 'flash' | undefined): 'on' | 'off' | 'flash' {
  if (raw === true) return 'on';
  if (raw === 'on') return 'on';
  if (raw === 'flash') return 'flash';
  return 'off';
}

/**
 * Format thinking/reasoning content for channel display.
 * Returns structured data so callers can set parse mode correctly.
 */
export function formatThinkingForChannel(thinking: string, chatJid: string): ThinkingFormat | null {
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  // Truncate very long thinking to avoid flooding the channel
  const maxLen = 2000;
  const content = trimmed.length > maxLen ? trimmed.substring(0, maxLen) + '\n...(truncated)' : trimmed;

  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (chatJid.startsWith('tg:')) {
    // Telegram: expandable blockquote (collapsed by default, tap to expand)
    return {
      text: `<blockquote expandable>🧠 Thinking:\n${escapeHtml(content)}</blockquote>`,
      parseMode: 'HTML',
    };
  } else {
    // Teams, Discord, TUI, etc.: standard blockquote
    return {
      text:
        '🧠 Thinking:\n' +
        content
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
    };
  }
}

/**
 * Format thinking/reasoning content for FLASH mode (transient inline preview).
 * Lightweight: no blockquote, italicized prefix, single-line collapse, channel-aware
 * parseMode. The flash UI is a placeholder that will be overwritten by the final
 * answer, so it should be visually quiet and not look like a persistent quote.
 */
export function formatThinkingForFlash(thinking: string, chatJid: string): ThinkingFormat | null {
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  // Tighter cap than persistent mode — this is meant to be transient.
  const maxLen = 600;
  // Collapse newlines into spaces so the preview stays compact (1–2 lines).
  const oneLine = trimmed.replace(/\s+/g, ' ');
  const content = oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '…' : oneLine;

  if (chatJid.startsWith('tg:')) {
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      text: `🧠 <i>thinking…</i> <i>${escapeHtml(content)}</i>`,
      parseMode: 'HTML',
    };
  } else if (chatJid.startsWith('discord:')) {
    // Discord: markdown italic.
    return {
      text: `🧠 _thinking…_ _${content.replace(/_/g, '\\_')}_`,
    };
  } else {
    // Teams / TUI / unknown: plain text. Markdown markers would just leak.
    return {
      text: `🧠 thinking… ${content}`,
    };
  }
}

/**
 * On-mode prepend dedup helper.
 *
 * A single agent query may emit multiple `partial=false` result events when
 * it contains tool calls (pre-tool final + post-tool final). Each event
 * carries the SDK's accumulated `result.thinking`. Without a flag, every
 * final gets thinking prepended again, so users see the (growing) thinking
 * block rendered twice in `on` mode (kenan TG repro 2026-04-25 18:06).
 *
 * Returns the new state and merged text. Pure function so it's unit-testable
 * outside the dispatcher closure. Use the returned `prepended` to update the
 * caller's per-query flag.
 *
 * Caller contract: only invoke when thinkingMode === 'on' && !partial.
 */
/**
 * Flash-mode opening lock for the FIRST `reasoning_delta` send.
 *
 * Bug 1 (kenan TG repro 2026-04-25 18:05):
 *   The first delta enters `if (!thinkingMsgId)` and awaits
 *   channel.sendMessage. While that promise is in flight, a second
 *   high-frequency delta arrives, ALSO sees thinkingMsgId === undefined,
 *   ALSO calls sendMessage → two orphan opening bubbles. The flash
 *   coalescer protects edits-once-msgId-known but had no protection
 *   for the open-msgId race.
 *
 * createOpeningLock() exposes:
 *   - openOnce(send): if no open is in flight, run send(); otherwise
 *     await the in-flight one. Either way, returns when the opener has
 *     resolved. The caller then re-checks msgId to decide whether to
 *     enqueue a follow-up edit.
 *   - reset(): drop the slot on turn boundary.
 *   - inFlight(): true while a sendMessage is pending (test introspection).
 */
export function createOpeningLock(): {
  openOnce: (send: () => Promise<void>) => Promise<void>;
  reset: () => void;
  inFlight: () => boolean;
} {
  let pending: Promise<void> | undefined;
  return {
    openOnce(send: () => Promise<void>): Promise<void> {
      if (pending) return pending;
      const p = send().finally(() => {
        if (pending === p) pending = undefined;
      });
      pending = p;
      return p;
    },
    reset(): void {
      pending = undefined;
    },
    inFlight(): boolean {
      return !!pending;
    },
  };
}

export function applyOnModeThinkingPrepend(args: {
  thinking: string | undefined;
  resultText: string;
  alreadyPrepended: boolean;
  formatted: { text: string; parseMode?: 'HTML' | 'Markdown' } | null;
}): {
  resultText: string;
  parseMode?: 'HTML' | 'Markdown';
  prepended: boolean;
} {
  if (args.alreadyPrepended || !args.thinking || !args.formatted) {
    return { resultText: args.resultText, prepended: args.alreadyPrepended };
  }
  return {
    resultText: `${args.formatted.text}\n\n${args.resultText}`,
    parseMode: args.formatted.parseMode,
    prepended: true,
  };
}

async function main(): Promise<void> {
  // Workspace guard: assert resolved workspace basename matches WORKSPACE_DIR_NAME
  // (or operator opt-in via NANOCLAW_WORKSPACE / setWorkspace). Aborts before
  // any file I/O if a stale staging path is somehow still routed in.
  try {
    const { assertWorkspaceIsolation } = await import('./workspace.js');
    const ws = assertWorkspaceIsolation();
    process.stderr.write(`[workspace] ${ws}\n`);
    // B.5 restore: install daily-rotated file log sink. Must run AFTER
    // workspace assert (so we know where logs/ goes) but BEFORE any
    // logger.* call we want captured to disk.
    try {
      const { installFileLogSink } = await import('./log-file-sink.js');
      const file = installFileLogSink();
      if (file) process.stderr.write(`[log] writing to ${file}\n`);
    } catch (sinkErr) {
      process.stderr.write(
        `[log] file sink install failed (continuing with stdout-only): ${(sinkErr as Error).message}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[workspace] startup guard failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Write PID file so `nanoclaw status` can detect us regardless of how we
  // were launched (manual `nanoclaw start` already does this for the wrapper
  // process, but systemd launches `node dist/index.js` directly and bypasses
  // that path — leaving status reporting "not running" while we're alive).
  // Owning the write here covers both launch modes with one source of truth.
  let pidFilePath: string | null = null;
  try {
    const { resolveWorkspace } = await import('./workspace.js');
    const ws = resolveWorkspace();
    pidFilePath = path.join(ws, 'state', 'nanoclaw.pid');
    fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
    fs.writeFileSync(pidFilePath, String(process.pid));
  } catch (err) {
    logger.warn({ err }, 'Failed to write PID file (status CLI may report stale)');
  }
  const cleanupPidFile = (): void => {
    if (!pidFilePath) return;
    try {
      const recorded = fs.readFileSync(pidFilePath, 'utf-8').trim();
      if (recorded === String(process.pid)) fs.unlinkSync(pidFilePath);
    } catch {
      /* file already gone or unreadable */
    }
  };
  process.on('exit', cleanupPidFile);

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // ─── v2 central DB init + migrations + config reconcile ───
  // Must run BEFORE loadState() — post-cutover (PR #49), `loadState`
  // → `getAllRegisteredGroups` → v2 facade → v2.db, which is opened
  // here. Pre-cutover ordering (loadState first) crashes boot with
  // 'Database not initialized'.
  // Separate file `<workspace>/store/v2.db` (legacy v1 keeps `messages.db`)
  // — avoids double-connection-on-same-file gotchas with WAL prepared-stmt
  // caches. After migrations, reconcile projects declared config (agents,
  // allowFrom users, owners, requireMention) into v2 tables so the router
  // has everything it needs on first inbound. Without this, module-level
  // `getDb()` throws "Database not initialized" on first inbound.
  // Fail-fast: if init/migrations/reconcile fails, exit(1) — silent log
  // would leave the bot dropping every message until restart anyway, and
  // systemd-restart-with-error is more visible than a half-dead process.
  try {
    const { initAndReconcileV2 } = await import('./db/v2-boot.js');
    const { dbPath, migrate, summary } = initAndReconcileV2();
    if (!migrate.noop) {
      logger.info(
        {
          snapshot: migrate.snapshotPath,
          dms: migrate.dms.length,
          groups: migrate.groups.length,
          ownersBootstrapped: migrate.ownersBootstrapped.length,
          legacyChatsMigrated: migrate.legacyChatsMigrated,
          legacyRegisteredGroupsMigrated: migrate.legacyRegisteredGroupsMigrated,
        },
        'v1 → v2 config auto-migrated',
      );
    }
    logger.info(
      {
        path: dbPath,
        agentGroupsInserted: summary.agentGroups.inserted.length,
        agentGroupsUpdated: summary.agentGroups.updated.length,
        agentGroupsArchived: summary.agentGroups.archived.length,
        usersInserted: summary.users.inserted.length,
        ownerRolesInserted: summary.userRoles.inserted.length,
        ownerRolesDeleted: summary.userRoles.deleted.length,
        agentGroupMembersInserted: summary.agentGroupMembers.inserted,
        messagingGroupAgentsUpdated: summary.messagingGroupAgents.updated,
      },
      'v2 DB initialized + reconciled',
    );
  } catch (err) {
    logger.fatal({ err }, 'v2 DB init failed — refusing to start (fail-fast, systemd will restart)');
    process.exit(1);
  }

  // Now safe to load v1 facade state — v2.db open + reconciled.
  loadState();

  // Apply config.logLevel as early as possible so subsequent startup logs
  // reflect the user's preferred verbosity. env LOG_LEVEL still wins inside
  // applyConfigLogLevel (it's locked in logger.ts at module init).
  try {
    const { loadConfig: lc } = await import('./config-loader.js');
    const { applyConfigLogLevel, getLogLevel } = await import('./log-extensions.js');
    const cfg = lc();
    applyConfigLogLevel(cfg.logLevel);
    logger.info(
      {
        level: getLogLevel(),
        source: process.env.LOG_LEVEL ? 'env' : 'config',
      },
      'Log level initialized',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to apply config.logLevel at startup');
  }

  // Clear stale agent PIDs from previous run
  try {
    const { clearAgentPids } = await import('./host-runner.js');
    clearAgentPids();
  } catch {
    /* */
  }

  // Chats config→DB sync retired 2026-05-16: nanoclaw.json no longer
  // carries a `chats` section. Inbound traffic + pair flow populate v2
  // messaging_groups directly, and `nanoclaw chat add` writes there too.
  try {
    registeredGroups = getAllRegisteredGroups();
  } catch (err: any) {
    logger.debug({ err }, 'getAllRegisteredGroups skipped');
  }

  // Auto-install plugins listed in nanoclaw.json `plugins.enabled[]`.
  // Mirrors CC's autoInstallEnabledPlugins. Best-effort: per-entry failures
  // are logged but never abort startup.
  try {
    const { ensureEnabledPluginsInstalled } = await import('./cli/plugin.js');
    const result = await ensureEnabledPluginsInstalled();
    if (result.installed.length > 0) {
      logger.info({ installed: result.installed }, 'plugins: auto-installed declared plugins');
    }
    for (const f of result.failed) {
      logger.warn({ plugin: f.name, error: f.error }, 'plugins: auto-install failed');
    }
  } catch (err: any) {
    logger.debug({ err }, 'plugins: auto-install skipped');
  }

  restoreRemoteControl();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // v2 host-sweep: heartbeat-based zombie detection (claim-stuck 60s default)
  // + optional absolute-ceiling throttle (default disabled per owner directive
  // 2026-05-10). The DB-scan half (container claim/ack/heartbeat) is
  // container-only — host mode has no per-session container, no claim/ack
  // table writes, and no heartbeat writer, so that half is a no-op there.
  // BUT the sweep loop also runs the agent-pid reaper (reapDeadAgentPids),
  // which IS needed in host mode — that's the backstop for the Windows
  // orphaned-process leak (2026-06-24). So we start the sweep in BOTH modes;
  // the DB scan self-skips in host mode (isDbInitialized guard + container
  // checks), and the reaper runs every tick regardless.
  try {
    const { loadConfig: lcSweep } = await import('./config-loader.js');
    const { startHostSweep } = await import('./host-sweep.js');
    const cfgSweep = lcSweep();
    const runtime = cfgSweep.sandbox?.runtime;
    const containerMode = runtime === 'docker' || runtime === 'apple-container';
    startHostSweep();
    logger.info({ mode: containerMode ? 'container' : 'host' }, 'Host sweep started');
  } catch (err) {
    logger.warn({ err }, 'Failed to start host sweep');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      const { stopHostSweep } = await import('./host-sweep.js');
      stopHostSweep();
    } catch {
      /* sweep may not have started */
    }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // SIGUSR2: re-read config and re-apply log level. Used by
  // `nanoclaw loglevel <level>`, `nanoclaw mcp add/remove`, and
  // `nanoclaw reload` for live updates without restart.
  process.on('SIGUSR2', async () => {
    await reloadFromConfigFile('SIGUSR2');
  });

  // Windows fallback: process.kill(pid, 'SIGUSR2') is a no-op on win32,
  // so the CLI helpers write a trigger file and the daemon polls for it.
  // ~2s cadence matches the Windows IPC poll interval; light cost since
  // it's just an fs.existsSync per tick.
  if (process.platform === 'win32') {
    const triggerPath = (() => {
      const ws = path.dirname(paths.config);
      return path.join(ws, 'state', 'reload.trigger');
    })();
    setInterval(() => {
      try {
        if (fs.existsSync(triggerPath)) {
          fs.unlinkSync(triggerPath);
          void reloadFromConfigFile('reload-trigger');
        }
      } catch (err) {
        logger.debug({ err }, 'Reload trigger poll error');
      }
    }, 2000).unref();
  }

  async function reloadFromConfigFile(source: string): Promise<void> {
    try {
      const { reloadConfig, getConfig } = await import('./config.js');
      const { applyConfigLogLevel, setLogLevel, getLogLevel } = await import('./log-extensions.js');
      reloadConfig();
      const cfg = getConfig();
      const newLevel = cfg.logLevel;
      // force=true so this overrides env-locked threshold (the user
      // explicitly asked via CLI; treat as a fresh manual override).
      if (newLevel) {
        setLogLevel(newLevel, { force: true });
      } else {
        applyConfigLogLevel(newLevel);
      }
      const mcpCount = Object.keys(cfg.mcp?.servers || {}).length;
      logger.info({ source, level: getLogLevel(), mcpServers: mcpCount }, 'Config reloaded');
    } catch (err) {
      logger.error({ source, err }, 'Config reload failed');
    }
  }

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(command: string, chatJid: string, msg: NewMessage): Promise<void> {
    const group = registeredGroups[chatJid];
    // Bucket A: privilege gate (remote-control). Dual-read shim.
    const isDefaultAgentGroup = group ? folderIsDefaultAgent(group.folder) === true : false;
    if (!isDefaultAgentGroup) {
      logger.warn({ chatJid, sender: msg.sender }, 'Remote control rejected: not main group');
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const { resolveWorkspace: rw } = await import('./workspace.js');
      const result = await startRemoteControl(msg.sender, chatJid, rw());
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(chatJid, `Remote Control failed: ${result.error}`);
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Shadow-mode v2 inbound: NANOCLAW_V2_DISPATCHER=2 fires routeInbound
      // in fire-and-forget parallel to v1 dispatch. shadowRoute is
      // sync-returning, swallows all errors, ignores own-bot echoes,
      // and skips delivery polls — so v1 stays authoritative and the
      // user-visible path is unchanged. Used to validate the v2 path
      // on real traffic before the full swap.
      //
      // Semantics (#49 step 9.5): only '2' enables shadow. v2 dispatch
      // wiring itself is on by default — see installV2DispatcherHooks.
      if (process.env.NANOCLAW_V2_DISPATCHER === '2') {
        shadowRoute(chatJid, msg);
      }
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err: any) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Fast-abort: stop / cancel / 停 / etc. while agent is busy.
      // Intercept BEFORE storage so the keyword isn't re-delivered to the LLM.
      if (!msg.is_from_me && isAbortRequestText(msg.content)) {
        const wasActive = queue.killActive(chatJid);
        if (wasActive) {
          logger.info({ chatJid, text: msg.content }, 'fast-abort triggered');
          const abortChannel = findChannel(channels, chatJid);
          abortChannel
            ?.sendMessage(chatJid, '⚙️ Agent aborted.')
            .catch((err: any) => logger.warn({ err, chatJid }, 'abort: failed to send ack'));
        }
        // Always return: we don't store abort keywords as regular messages,
        // regardless of whether anything was actually running.
        return;
      }

      // Unified pair instructions for unregistered chats
      if (!msg.is_from_me && !registeredGroups[chatJid]) {
        // Check DB in case a channel (e.g. TUI) auto-registered
        const freshGroups = getAllRegisteredGroups();
        if (freshGroups[chatJid]) {
          registeredGroups = freshGroups;
        } else {
          const pairChannel = findChannel(channels, chatJid);
          if (pairChannel) {
            const senderName = msg.sender || 'chat';
            const safeName = senderName.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 40);
            pairChannel
              .sendMessage(
                chatJid,
                `👋 This chat isn't paired yet.\n\nTo pair, run on your server:\n\`nanoclaw pair ${chatJid} --name "${safeName}"\`\n\`nanoclaw restart\``,
              )
              .catch((err: any) => logger.debug({ err, chatJid }, 'Failed to send pair instructions'));
          }
          return;
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
          if (cfg.logDenied) {
            logger.debug({ chatJid, sender: msg.sender }, 'sender-allowlist: dropping message (drop mode)');
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  // Multi-account: iterate accounts{} if present, creating one instance per account.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channelConfig = (getConfig().channels as any)?.[channelName];
    const accounts = channelConfig?.accounts as Record<string, any> | undefined;

    // Build list of (accountId, opts) pairs to instantiate
    const accountEntries: Array<{ accountId?: string }> = accounts
      ? Object.keys(accounts).map((id) => ({ accountId: id }))
      : [{ accountId: undefined }]; // single instance (no accounts)

    for (const { accountId } of accountEntries) {
      const opts = { ...channelOpts, ...(accountId ? { accountId } : {}) };
      const channel = factory(opts);
      if (!channel) {
        logger.warn({ channel: channelName, accountId }, 'Channel installed but credentials missing — skipping.');
        continue;
      }
      channels.push(channel);
      await channel.connect();

      // Register slash commands with platform-native menus (non-invasive)
      try {
        const { registerTelegramCommands } = await import('./slash-commands.js');
        if (channelName === 'telegram') {
          // Multi-account: register for each account's bot token
          const tgConfig = getConfig().channels?.telegram;
          const accts = tgConfig?.accounts;
          if (accts && accountId && accts[accountId]?.botToken) {
            await registerTelegramCommands(accts[accountId].botToken!);
            logger.info({ accountId }, 'Telegram slash command menu registered');
          } else if (tgConfig?.botToken) {
            await registerTelegramCommands(tgConfig.botToken);
            logger.info('Telegram slash command menu registered');
          }
        }
      } catch (err) {
        logger.debug({ err, channel: channelName }, 'Slash command registration skipped');
      }
    } // end accountEntries loop
  }
  if (channels.length === 0) {
    logger.warn('No channels connected — service running for TUI/IPC only');
  }

  // Tunnel health ring: the `devtunnel host` process can outlive its relay
  // connection for days (NAT/relay idle close, token expiry, wifi blip),
  // silently killing all Teams inbound while `ncl status` shows green because
  // it only probed the pid. `ensureTunnelHosting` ran once at `ncl start` and
  // nothing re-hosted afterwards. This supervisor periodically probes the real
  // connection and auto-rehosts, and writes state/tunnel-health.json so status
  // reports the true connection state. No-ops when there is no tunnel to watch
  // (Teams disabled / proxy transport / devtunnel absent).
  try {
    const { resolveNanoclawTunnelId } = await import('./cli/tunnel-lifecycle.js');
    const { startTunnelSupervisor } = await import('./cli/tunnel-supervisor.js');
    const tunnelId = await resolveNanoclawTunnelId();
    if (tunnelId) {
      const { resolveWorkspace } = await import('./workspace.js');
      startTunnelSupervisor({
        ws: resolveWorkspace(),
        tunnelId,
        logger: { info: (o, m) => logger.info(o, m), warn: (o, m) => logger.warn(o, m) },
      });
      logger.info({ tunnelId }, 'Tunnel health supervisor started');
    }
  } catch (err) {
    logger.warn({ err }, 'Tunnel health supervisor not started');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) return await channel.sendMessage(jid, text);
    },
    editMessage: async (jid, messageId, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel?.editMessage) return;
      const text = formatOutbound(rawText);
      if (text) return await channel.editMessage(jid, messageId, text);
    },
  });

  // ─── v2 dispatcher wiring (v2 is the default since fixup #49 step 9.5) ─
  // Inbound routing goes through src/router.ts (`routeInboundEvent`) which
  // resolves messaging_group → agent → access gate (upstream
  // `canAccessAgentGroup` via setAccessGate) → session → container wake.
  // Auto-wiring of `messaging_group_agents` from `config.bindings[]` happens
  // on lazy `messaging_groups` create in router.ts (PR-D step 1.2).
  // Implementation extracted to src/v2-dispatcher-wiring.ts for unit testing
  // (src/v2-dispatcher-wiring.test.ts). Env var modes:
  //   unset / '1' / any other value  → v2 path (default).
  //   '2'                            → v2 + shadow inbound dispatch.
  //   '0' / 'legacy'                 → fork v1 only (emergency rollback).
  const v2ModeRaw = process.env.NANOCLAW_V2_DISPATCHER;
  const v2Enabled = !(v2ModeRaw === '0' || v2ModeRaw === 'legacy');
  // eslint-disable-next-line no-console
  console.info(
    v2Enabled
      ? '[v2] dispatcher: v2 (set NANOCLAW_V2_DISPATCHER=0 to fall back to legacy)'
      : '[v2] dispatcher: legacy (NANOCLAW_V2_DISPATCHER=' + v2ModeRaw + ')',
  );
  const { installV2DispatcherHooks } = await import('./v2-dispatcher-wiring.js');
  await installV2DispatcherHooks(v2ModeRaw, {
    killActive: (jid: string) => queue.killActive(jid),
    sendAck: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
    logger,
  });
  // ─────────────────────────────────────────────────────────────────

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    reactToMessage: async (jid, emoji, messageId) => {
      const channel = findChannel(channels, jid);
      if (channel?.reactToMessage) {
        await channel.reactToMessage(jid, emoji, messageId);
      } else {
        logger.debug({ jid, emoji }, 'Channel does not support reactions');
      }
    },
    sendFile: async (jid, filePath, filename) => {
      const channel = findChannel(channels, jid);
      if (channel?.sendFile) {
        await channel.sendFile(jid, filePath, filename);
      } else {
        logger.debug({ jid, filePath }, 'Channel does not support file sending');
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(force)));
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
        kind: t.kind,
      }));
      for (const group of Object.values(registeredGroups)) {
        // Best-effort between-turns refresh. No per-user context here, so
        // we can only grant the default-agent folder the all-tasks view;
        // an owner's cross-folder visibility is (re)applied on their next
        // turn by the operator-aware write in runAgent(). Writing
        // operator=true for every folder here would leak all tasks into
        // non-owner folders' snapshots, so we deliberately keep this
        // folder-scoped.
        writeTasksSnapshot(group.folder, folderIsDefaultAgent(group.folder) === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  // Recover from agent crashes/timeouts that happen after IPC pipe but
  // before output: rollback the message cursor so dropped messages get
  // re-read from the DB by the next agent spawn, and clear the typing
  // indicator (set fire-and-forget at the IPC pipe site — nothing else
  // would clear it on this code path).
  queue.setOnProcessDiedWithoutOutput((groupJid: string, rollbackCursor: string | null, exitCode: number | null) => {
    const channel = findChannel(channels, groupJid);
    if (channel) {
      traceSetTyping(channel, groupJid, false, 'agent-died').catch((err: any) =>
        logger.warn({ groupJid, err }, 'Failed to clear typing indicator after agent died'),
      );
    }
    // Surface non-zero exits to the user so they don't sit watching
    // radio silence after a crash. Honours the same `sendErrorToUser`
    // config gate as the structured-error path. (kenan, 2026-04-21
    // gitignore reproducer: agent exit code=1 → bot said nothing.)
    const sendErrors = getConfig().sendErrorToUser === true;
    if (sendErrors && channel && exitCode !== null && exitCode !== 0 && !queue.isShuttingDown()) {
      const msg =
        `⚠️ Agent process crashed (exit ${exitCode}). ` + `Send your message again and a fresh agent will pick it up.`;
      channel
        .sendMessage(groupJid, msg)
        .catch((err: any) =>
          logger.warn({ groupJid, exitCode, err }, 'Failed to deliver agent-crash notice to channel'),
        );
    }
    if (rollbackCursor) {
      const before = lastAgentTimestamp[groupJid];
      lastAgentTimestamp[groupJid] = rollbackCursor;
      saveState();
      logger.warn(
        { groupJid, before, rolledBackTo: rollbackCursor },
        'Agent died with piped IPC messages in flight; rolled back cursor',
      );
    } else {
      logger.info({ groupJid }, 'Agent died while idle but no piped messages in flight; cursor untouched');
    }
  });
  recoverPendingMessages();
  startMessageLoop().catch((err: any) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests.
//
// Symlink-safety (2026-05-17 systemd repro): `import.meta.url` is resolved
// through symlinks, while `process.argv[1]` is the literal launch path.
// `npm link` / global installs leave argv[1] pointing at the symlink and
// import.meta.url at the realpath, so a naive `===` check returned false
// and main() never ran (Node then exited 0 silently). Resolve both ends
// through `fs.realpathSync` before comparing.
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    const lhs = fs.realpathSync(fileURLToPath(import.meta.url));
    const rhs = fs.realpathSync(path.resolve(process.argv[1]));
    return lhs === rhs;
  } catch {
    // realpath can throw on Windows or for ephemeral entry paths; fall back
    // to the pre-fix comparison so we don't worsen any working setup.
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
})();

if (isDirectRun) {
  main().catch((err: any) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
