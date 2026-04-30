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
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  getConfig,
} from './config.js';
import { getEffectiveShowThinking } from './session-overrides.js';
import { createFlashEditCoalescer } from './flash-edit-coalescer.js';
import {
  runAgentForChat,
  IS_GHC_PROVIDER,
  resolveAgentForChat,
  getAgentProvider,
} from './config-extensions.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
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
import {
  findChannel,
  formatMessages,
  formatOutbound,
  formatConversationContext,
} from './text-format.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler-bridge.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './log.js';

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
  if (!onecli || group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli!.ensureAgent({ name: group.name, identifier }).then(
    (res: any) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err: any) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
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
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
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
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
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
  logger.info(
    { chatJid, channel: channel.name, isTyping, reason },
    'Channel typing state change',
  );
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
const boundedTypingTimers = new Map<string, NodeJS.Timeout>();

/**
 * TTL for the bounded typing pulse after an interim final-output. Long
 * enough to bridge a normal think-then-act gap (a few seconds) without
 * leaving the indicator stuck if no follow-up output arrives. Channels
 * tick their own keepalive at 3-4s, so 8s comfortably covers ~2 ticks.
 */
const INTERIM_TYPING_TTL_MS = 8000;

function cancelBoundedTypingClear(chatJid: string): void {
  const t = boundedTypingTimers.get(chatJid);
  if (t) {
    clearTimeout(t);
    boundedTypingTimers.delete(chatJid);
  }
}

/**
 * Re-arm typing as a bounded pulse: arms the channel keepalive, then
 * schedules an auto-clear after `ttlMs` if nothing else has touched
 * typing in the meantime. The next traceSetTyping (any direction)
 * cancels the pending clear via cancelBoundedTypingClear.
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
  await traceSetTyping(channel, chatJid, true, reason);
  // traceSetTyping cleared any prior bounded timer; install a fresh one.
  const t = setTimeout(() => {
    boundedTypingTimers.delete(chatJid);
    // Use the underlying channel.setTyping directly so we don't recurse
    // through cancelBoundedTypingClear (no-op anyway since we just
    // deleted the entry, but explicit is clearer).
    if (channel.setTyping) {
      channel.setTyping(chatJid, false).catch((err: any) => {
        logger.warn(
          { chatJid, channel: channel.name, err: err?.message ?? err },
          'bounded typing auto-clear failed',
        );
      });
    }
  }, ttlMs);
  boundedTypingTimers.set(chatJid, t);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err: any) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
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
    const templateFile = path.join(
      DATA_DIR,
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
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

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
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

  const isMainGroup = group.isMain === true;

  let missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Handle slash commands in ALL messages, not just the last one.
  // Separate slash commands from regular messages to avoid swallowing.
  const { normalizeSlashInput, handleSlashCommand } =
    await import('./slash-commands.js');
  const slashCtx = {
    chatJid,
    groupFolder: group.folder,
    channel: findChannel(channels, chatJid),
    clearSession: (folder: string) => delete sessions[folder],
    killActiveRunner: (jid: string) => queue.killActive(jid),
  };
  const regularMessages: typeof missedMessages = [];
  for (const msg of missedMessages) {
    const slashInput = normalizeSlashInput(msg.content);
    const slashResult = await handleSlashCommand(slashInput, slashCtx);
    if (slashResult.handled) {
      lastAgentTimestamp[chatJid] = msg.timestamp;
    } else {
      regularMessages.push(msg);
    }
  }
  saveState();

  if (regularMessages.length === 0) return true;

  // Replace missedMessages with non-slash messages for further processing
  missedMessages = regularMessages;

  // For non-main groups, check if trigger is required and present
  // (after slash commands, so /think etc. work without @mention)
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
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
  const prompt = historyPrefix
    ? historyPrefix + '\n\n' + newMessages
    : newMessages;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (IDLE_TIMEOUT <= 0) return; // 0 = never timeout
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

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
  let streamHandle: import('./types.js').StreamHandle | undefined;
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
  // Independent turn-boundary signal sourced from GroupQueue. The SDK's
  // newSessionId sentinel only fires for the FIRST turn of a session;
  // follow-up user messages piped to a running container reuse the same
  // sessionId, so the dispatcher would never see a sentinel for turns 2+.
  // GroupQueue increments userTurnSeq on every pipe (initial + follow-up),
  // so comparing against the last-seen value gives a reliable per-turn
  // boundary regardless of SDK sentinel behaviour. (kenan TG repro
  // 2026-04-25 22:54: 4 user msgs, 1 sentinel, 3 missed turn boundaries.)
  let lastUserTurnSeqSeen = queue.getUserTurnSeq(chatJid);
  // True after a result.result with !partial fires for the current turn.
  // Any further thinking / reasoning_delta events that arrive before a new
  // turn boundary (userTurnSeq advance OR sentinel) are SDK trailing-delta
  // artifacts that must be ignored — otherwise they open orphan thinking
  // bubbles AFTER the answer was already finalized (kenan TG repro
  // 2026-04-26 00:03: thinking bubble appeared post-answer).
  let turnFinalized = false;
  // Thinking message state (separate from answer progressive message)

  try {
    const output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback

      // Query-complete sentinel: agent finished a query and is waiting for
      // the next IPC pipe (IPC mode only). Mark a boundary so the next
      // non-null result resets per-turn message-id state. Doing the reset
      // here (on the sentinel) instead of pre-emptively at the top of the
      // next turn avoids racing with trailing partials of the current turn.
      if (
        result.result === null &&
        (result as any).newSessionId &&
        !result.partial
      ) {
        queryBoundaryPendingThinking = true;
        queryBoundaryPendingResult = true;
        // Don't return — let the rest of the handler run for thinking/status
        // bookkeeping, then exit naturally on the !result.result guard above.
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
          lastUserTurnSeqSeen = currentSeq;
          queryBoundaryPendingThinking = true;
          queryBoundaryPendingResult = true;
          turnFinalized = false;
        }
        const thinkingMode = normalizeShowThinking(
          getEffectiveShowThinking(chatJid) ??
            getConfig().agents?.defaults?.showThinking,
        );
        const streamThinking =
          thinkingMode === 'flash' &&
          !!channel.editMessage &&
          !channel.usesNativeStreaming;
        // In flash mode, once we've dismissed the thinking preview on the
        // first answer chunk, ignore trailing reasoning_delta events for
        // the rest of the turn (don't re-open it).
        if (
          streamThinking &&
          channel.editMessage &&
          !(thinkingMode === 'flash' && flashThinkingDismissed)
        ) {
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
            const sendOpts = tp.parseMode
              ? { parseMode: tp.parseMode }
              : undefined;
            if (!thinkingMsgId) {
              // Opening lock: openOnce() either runs sendMessage (if we're
              // first) or awaits the in-flight opener (if a sibling delta
              // beat us). After it resolves, thinkingMsgId is set and the
              // late delta falls through to the coalescer enqueue branch.
              await flashOpeningLock.openOnce(async () => {
                await traceSetTyping(channel, chatJid, false, 'thinking-first');
                const desired = tp.text + ' ◌';
                const msgId = await channel.sendMessage(
                  chatJid,
                  desired,
                  sendOpts,
                );
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
          logger.debug(
            { chatJid, group: group.name },
            'IPC turn boundary: reset per-turn message-id state',
          );
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
          getEffectiveShowThinking(chatJid) ??
            getConfig().agents?.defaults?.showThinking,
        );
        if (
          result.thinking &&
          !result.partial &&
          thinkingMode === 'on' &&
          !thinkingPrependedThisQuery
        ) {
          const tp = formatThinkingForChannel(result.thinking, chatJid);
          const merged = applyOnModeThinkingPrepend({
            thinking: result.thinking,
            resultText:
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result),
            alreadyPrepended: thinkingPrependedThisQuery,
            formatted: tp,
          });
          if (merged.prepended) {
            thinkingParseMode = merged.parseMode;
            result.result = merged.resultText;
            thinkingPrependedThisQuery = true;
          }
        }
        if (
          thinkingMsgId &&
          thinkingMode === 'flash' &&
          !flashThinkingDismissed
        ) {
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
            logger.warn(
              { chatJid, err: (err as Error).message },
              'flash thinking dismiss failed (non-fatal)',
            );
          }
          thinkingMsgId = undefined;
          flashThinkingDismissed = true;
        }
        // (`on` mode now merges thinking into result.result above; the
        //  streamed-thinking-message design from PR #27 was reverted on
        //  2026-04-25 after producing orphan-bubble regression on TG.)
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (!text) {
          if (result.status === 'success') queue.notifyIdle(chatJid);
          return;
        }

        // Agent produced output for the user — reset busy-ack debounce so any
        // future silent stretch on a follow-up message can be acked again.
        queue.notifyAgentOutput(chatJid);

        const sendOpts = thinkingParseMode
          ? { parseMode: thinkingParseMode }
          : undefined;

        if (
          result.partial &&
          channel.usesNativeStreaming &&
          channel.streamMessage
        ) {
          // Native streaming path: hand cumulative text to the channel's
          // StreamHandle. The handle is responsible for serializing
          // outbound activities and graceful degradation on platforms
          // that reject mid-stream. We never call sendMessage/editMessage
          // here, so updateActivity races (the partial+final duplicate
          // bug) cannot occur on this path.
          progressiveText = text;
          if (!streamHandle) {
            await traceSetTyping(channel, chatJid, false, 'native-stream-open');
            streamHandle = await channel.streamMessage(chatJid, sendOpts);
          }
          await streamHandle.chunk(text);
        } else if (result.partial && channel.editMessage) {
          // Delta/partial: accumulate and edit existing message.
          progressiveText = text; // delta buffer already accumulated in agent-runner
          if (!progressiveMsgId) {
            // First partial — send new message
            await traceSetTyping(
              channel,
              chatJid,
              false,
              'progressive-first-partial',
            );
            const msgId = await channel.sendMessage(
              chatJid,
              text + ' ◌',
              sendOpts,
            );
            progressiveMsgId = typeof msgId === 'string' ? msgId : undefined;
          } else {
            // Subsequent partial — edit existing message. Capture id in
            // case editMessage falls back to a fresh sendMessage (returns
            // a new id) so we keep editing the live message instead of
            // spawning duplicates. (kenan TG repro 2026-04-24)
            const editedId = await channel.editMessage(
              chatJid,
              progressiveMsgId,
              text + ' ◌',
              sendOpts,
            );
            if (typeof editedId === 'string' && editedId !== progressiveMsgId) {
              progressiveMsgId = editedId;
            }
          }
        } else {
          // Final message (or channel doesn't support edit)
          await traceSetTyping(channel, chatJid, false, 'final-output');
          if (streamHandle) {
            // Native streaming path: close the stream with the final text.
            // The handle owns whether this becomes a new message or replaces
            // the in-flight stream bubble (Teams: replaces; others: TBD).
            const msgId = await streamHandle.end(text);
            streamHandle = undefined;
            lastFinalMsgId = typeof msgId === 'string' ? msgId : undefined;
          } else if (progressiveMsgId && channel.editMessage) {
            // Replace the progressive message with final content. Capture
            // the (possibly new) id from the editMessage fallback path so
            // lastFinalMsgId tracks the actual visible message.
            const editedId = await channel.editMessage(
              chatJid,
              progressiveMsgId,
              text,
              sendOpts,
            );
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
            const editedId = await channel.editMessage(
              chatJid,
              lastFinalMsgId,
              text,
              sendOpts,
            );
            if (typeof editedId === 'string' && editedId !== lastFinalMsgId) {
              lastFinalMsgId = editedId;
            }
          } else {
            const msgId = await channel.sendMessage(chatJid, text, sendOpts);
            lastFinalMsgId = typeof msgId === 'string' ? msgId : undefined;
          }
          progressiveMsgId = undefined;
          progressiveText = '';
          outputSentToUser = true;
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
          await armTypingBounded(
            channel,
            chatJid,
            'after-interim-final',
            INTERIM_TYPING_TTL_MS,
          );
        }
        logger.info(
          { group: group.name, partial: !!result.partial },
          `Agent output: ${raw.length} chars`,
        );
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    await traceSetTyping(channel, chatJid, false, 'turn-end');
    if (idleTimer) clearTimeout(idleTimer);

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
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  } finally {
    // Safety net: always release typing + clear idle timer, even if anything
    // above threw. traceSetTyping swallows its own errors; idleTimer cleanup
    // is no-throw. The 'finally-guard' reason makes stuck-typing investigations
    // greppable: if grep shows finally-guard right before a stuck-typing
    // report, an exception escaped the happy path.
    if (idleTimer) clearTimeout(idleTimer);
    // Cancel any unfinished native stream so the channel can clean up its
    // queue / mark the stream bubble as ended on the user's client. cancel()
    // is idempotent; called even if a normal end() already fired (the second
    // call no-ops).
    if (streamHandle) {
      try {
        await streamHandle.cancel();
      } catch (err) {
        logger.warn(
          { chatJid, err: (err as Error).message },
          'streamHandle.cancel in finally-guard failed (non-fatal)',
        );
      }
    }
    await traceSetTyping(channel, chatJid, false, 'finally-guard');
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Resolve which provider this chat's agent uses, then look up the
  // sessionId for THAT provider only. A group can have separate
  // CC and GHC sessions and they don't cross-contaminate.
  const agent = resolveAgentForChat(chatJid);
  const provider = getAgentProvider(agent);
  const sessionId = sessions[group.folder]?.[provider];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

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
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
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
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

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

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );

      // Send error feedback to user (if enabled and not shutting down)
      const sendErrors = getConfig().sendErrorToUser === true;
      if (sendErrors && !queue.isShuttingDown()) {
        try {
          const errMsg = output.error || 'Unknown error';
          let userMessage = '\u26a0\ufe0f Unable to process your message.';
          if (errMsg.includes('docker') || errMsg.includes('Docker')) {
            userMessage +=
              ' Docker is not running or not installed. Run "nanoclaw doctor" to check.';
          } else if (errMsg.includes('timeout')) {
            userMessage += ' The agent timed out processing your request.';
          } else if (
            errMsg.includes('ERR_MODULE_NOT_FOUND') ||
            errMsg.includes('Cannot find package')
          ) {
            userMessage +=
              ' Container image may be outdated or wrong provider. Run "nanoclaw sandbox build" to rebuild.';
          } else if (
            errMsg.includes('No authentication info') ||
            errMsg.includes('not created with authentication')
          ) {
            userMessage +=
              ' Authentication failed. Check your GitHub token or API key configuration.';
          } else if (
            errMsg.includes('No such image') ||
            errMsg.includes('image not found')
          ) {
            userMessage +=
              ' Container image not found. Run "nanoclaw sandbox build" to build it.';
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
        if (
          errMsg.includes('docker') ||
          errMsg.includes('ENOENT') ||
          errMsg.includes('spawn')
        ) {
          userMessage +=
            ' Docker may not be running or installed. Run "nanoclaw doctor" to check.';
        } else if (errMsg.includes('timeout')) {
          userMessage += ' The agent timed out processing your request.';
        } else if (
          errMsg.includes('ERR_MODULE_NOT_FOUND') ||
          errMsg.includes('Cannot find package')
        ) {
          userMessage +=
            ' Container image may be outdated or wrong provider. Run "nanoclaw sandbox build" to rebuild.';
        } else if (
          errMsg.includes('No authentication info') ||
          errMsg.includes('not created with authentication')
        ) {
          userMessage +=
            ' Authentication failed. Check your GitHub token or API key configuration.';
        } else if (
          errMsg.includes('No such image') ||
          errMsg.includes('image not found')
        ) {
          userMessage +=
            ' Container image not found. Run "nanoclaw sandbox build" to build it.';
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
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

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

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
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
          let messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Handle slash commands in ALL pending messages, not just the last
          if (messagesToSend.length > 0) {
            const { normalizeSlashInput, handleSlashCommand } =
              await import('./slash-commands.js');
            const slashCtx2 = {
              chatJid,
              groupFolder: group.folder,
              channel: findChannel(channels, chatJid),
              clearSession: (folder: string) => delete sessions[folder],
              killActiveRunner: (jid: string) => queue.killActive(jid),
            };
            const nonSlash: typeof messagesToSend = [];
            for (const msg of messagesToSend) {
              const slashInput = normalizeSlashInput(msg.content);
              const slashResult = await handleSlashCommand(
                slashInput,
                slashCtx2,
              );
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
          const fullPrompt = contextPrefix
            ? contextPrefix + '\n\n' + formatted
            : formatted;

          // Capture cursor BEFORE the optimistic advance so we can roll
          // back to it if the active agent dies before producing output
          // (host-runner SIGTERM, IPC pipe race, etc). Without rollback,
          // these messages are silently lost — they're already past the
          // cursor when the next agent spawn drains the DB.
          const cursorBeforePipe = lastAgentTimestamp[chatJid] || '';
          if (queue.sendMessage(chatJid, fullPrompt, cursorBeforePipe)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            traceSetTyping(channel, chatJid, true, 'ipc-pipe').catch(
              (err: any) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
            // Busy ack: if user piled on a 2nd message before the agent
            // produced anything, let them know we received it and are still
            // working. 1st message = typing indicator only; 3rd+ = silent.
            const ackDepth = queue.shouldSendBusyAck(chatJid);
            if (ackDepth !== null) {
              channel
                .sendMessage(
                  chatJid,
                  `📥 收到，正在处理上一条，这是第 ${ackDepth} 条，处理完会一起回复。`,
                )
                ?.catch((err: any) =>
                  logger.warn({ chatJid, err }, 'Failed to send busy ack'),
                );
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
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
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
    config.agents?.list?.some((a: any) => a.mode === 'sandbox') ||
    config.agents?.defaults?.mode !== 'host';
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
    console.warn(
      '\n  \u26a0\ufe0f  WARNING: Docker is not running or not installed.',
    );
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
export function normalizeShowThinking(
  raw: boolean | 'on' | 'off' | 'flash' | undefined,
): 'on' | 'off' | 'flash' {
  if (raw === true) return 'on';
  if (raw === 'on') return 'on';
  if (raw === 'flash') return 'flash';
  return 'off';
}

/**
 * Format thinking/reasoning content for channel display.
 * Returns structured data so callers can set parse mode correctly.
 */
export function formatThinkingForChannel(
  thinking: string,
  chatJid: string,
): ThinkingFormat | null {
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  // Truncate very long thinking to avoid flooding the channel
  const maxLen = 2000;
  const content =
    trimmed.length > maxLen
      ? trimmed.substring(0, maxLen) + '\n...(truncated)'
      : trimmed;

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
export function formatThinkingForFlash(
  thinking: string,
  chatJid: string,
): ThinkingFormat | null {
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  // Tighter cap than persistent mode — this is meant to be transient.
  const maxLen = 600;
  // Collapse newlines into spaces so the preview stays compact (1–2 lines).
  const oneLine = trimmed.replace(/\s+/g, ' ');
  const content =
    oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '…' : oneLine;

  if (chatJid.startsWith('tg:')) {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  // v2 workspace isolation: seed v2 from v1 on first run, then assert we are
  // NOT pointing at the legacy v1 path. Both run before any file I/O so a
  // misconfigured deploy aborts before it can corrupt v1 prod data.
  try {
    const { assertWorkspaceIsolation, seedV2FromV1IfNeeded } =
      await import('./workspace.js');
    seedV2FromV1IfNeeded();
    const ws = assertWorkspaceIsolation();
    process.stderr.write(`[workspace] ${ws}\n`);
  } catch (err) {
    process.stderr.write(
      `[workspace] startup guard failed: ${(err as Error).message}\n`,
    );
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
    logger.warn(
      { err },
      'Failed to write PID file (status CLI may report stale)',
    );
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
  loadState();

  // Apply config.logLevel as early as possible so subsequent startup logs
  // reflect the user's preferred verbosity. env LOG_LEVEL still wins inside
  // applyConfigLogLevel (it's locked in logger.ts at module init).
  try {
    const { loadConfig: lc } = await import('./config-loader.js');
    const { applyConfigLogLevel, getLogLevel } = await import('./log.js');
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

  // Sync chats from nanoclaw.json config into DB
  try {
    const { loadConfig } = await import('./config-loader.js');
    const { syncChatsFromConfig } = await import('./chat-manager.js');
    const config = loadConfig();
    syncChatsFromConfig(config);
    // Refresh in-memory groups after sync
    registeredGroups = getAllRegisteredGroups();
  } catch (err: any) {
    logger.debug({ err }, 'Chat sync from config skipped');
  }

  // Auto-install plugins listed in nanoclaw.json `plugins.enabled[]`.
  // Mirrors CC's autoInstallEnabledPlugins. Best-effort: per-entry failures
  // are logged but never abort startup.
  try {
    const { ensureEnabledPluginsInstalled } = await import('./cli/plugin.js');
    const result = await ensureEnabledPluginsInstalled();
    if (result.installed.length > 0) {
      logger.info(
        { installed: result.installed },
        'plugins: auto-installed declared plugins',
      );
    }
    for (const f of result.failed) {
      logger.warn(
        { plugin: f.name, error: f.error },
        'plugins: auto-install failed',
      );
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

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
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
      const { applyConfigLogLevel, setLogLevel, getLogLevel } =
        await import('./log.js');
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
      logger.info(
        { source, level: getLogLevel(), mcpServers: mcpCount },
        'Config reloaded',
      );
    } catch (err) {
      logger.error({ source, err }, 'Config reload failed');
    }
  }

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
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
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
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
            .catch((err: any) =>
              logger.warn({ err, chatJid }, 'abort: failed to send ack'),
            );
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
            const safeName = senderName
              .replace(/[^a-zA-Z0-9_-]/g, '-')
              .substring(0, 40);
            pairChannel
              .sendMessage(
                chatJid,
                `👋 This chat isn't paired yet.\n\nTo pair, run on your server:\n\`nanoclaw pair ${chatJid} --name "${safeName}"\`\n\`nanoclaw restart\``,
              )
              .catch((err: any) =>
                logger.debug(
                  { err, chatJid },
                  'Failed to send pair instructions',
                ),
              );
          }
          return;
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
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
        logger.warn(
          { channel: channelName, accountId },
          'Channel installed but credentials missing — skipping.',
        );
        continue;
      }
      channels.push(channel);
      await channel.connect();

      // Register slash commands with platform-native menus (non-invasive)
      try {
        const { registerTelegramCommands } =
          await import('./slash-commands.js');
        if (channelName === 'telegram') {
          // Multi-account: register for each account's bot token
          const tgConfig = getConfig().channels?.telegram;
          const accts = tgConfig?.accounts;
          if (accts && accountId && accts[accountId]?.botToken) {
            await registerTelegramCommands(accts[accountId].botToken!);
            logger.info(
              { accountId },
              'Telegram slash command menu registered',
            );
          } else if (tgConfig?.botToken) {
            await registerTelegramCommands(tgConfig.botToken);
            logger.info('Telegram slash command menu registered');
          }
        }
      } catch (err) {
        logger.debug(
          { err, channel: channelName },
          'Slash command registration skipped',
        );
      }
    } // end accountEntries loop
  }
  if (channels.length === 0) {
    logger.warn('No channels connected — service running for TUI/IPC only');
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

  // ─── B.5.3 v2 dispatcher wiring (env-gated, default off) ──────────
  // When NANOCLAW_V2_DISPATCHER=1, install the v2 router-side hooks so
  // sender-allowlist-extensions + abort-extensions take effect via the v2
  // access-gate / abort-handler registries. The fork v1 dispatcher
  // loop (startMessageLoop below) STILL runs — this is wiring-only,
  // not a swap. Full swap (replace v1 message loop with
  // router.routeInbound + channel adapters-barrel + delivery polls)
  // lands when the channel barrel swap (L5) goes in alongside it.
  //
  // Why behind a flag: production deploy today is fork v1 only. The
  // v2 path is type-green + test-green but lacks an end-to-end smoke
  // run on a live channel. Flag keeps the wiring in code (so future
  // smokes can flip it on) without changing default startup behaviour.
  //
  // Modes:
  //   unset / 0  → fork v1 only (default).
  //   '1'        → wiring only (gates + resolvers installed; no inbound
  //                 dispatch change). For unit-style integration smoke.
  //   '2'        → wiring + shadow inbound. v1 dispatch stays
  //                 authoritative, but every onMessage also triggers
  //                 routeInbound() fire-and-forget so the v2 router
  //                 sees real traffic. Delivery polls stay off so the
  //                 router doesn't double-send. See `src/shadow-inbound.ts`.
  const v2Mode = process.env.NANOCLAW_V2_DISPATCHER;
  if (v2Mode === '1' || v2Mode === '2') {
    try {
      const { setAccessGate } = await import('./router.js');
      const { makeSenderAllowlistGate } = await import(
        './modules/sender-allowlist-extensions/index.js'
      );
      const { installAbortFork } = await import(
        './modules/abort-extensions/index.js'
      );
      const { installRegisteredGroupsFork } = await import(
        './modules/registered-groups-extensions/index.js'
      );
      // v2 module barrels self-register on import (approvals,
      // interactive, scheduling, permissions, agent-to-agent,
      // self-mod). Importing here, after channel adapters init,
      // matches the boot order specified in
      // docs/v2-migration-inventory.md §"Side-effect import order".
      await import('./modules/index.js');

      setAccessGate(makeSenderAllowlistGate());
      installAbortFork({
        killActive: (jid: string) => queue.killActive(jid),
        sendAck: async (jid: string, text: string) => {
          const channel = findChannel(channels, jid);
          if (channel) await channel.sendMessage(jid, text);
        },
      });
      installRegisteredGroupsFork();
      logger.info(
        {
          gates: ['sender-allowlist'],
          abortHandler: 'fork',
          groupResolver: 'registered-groups-extensions',
          mode: v2Mode,
          shadow: v2Mode === '2',
        },
        'v2 dispatcher hooks installed (NANOCLAW_V2_DISPATCHER=' + v2Mode + ')',
      );
    } catch (err) {
      logger.error(
        { err },
        'v2 dispatcher wiring failed; continuing with fork v1 path only',
      );
    }
  }
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
        logger.debug(
          { jid, filePath },
          'Channel does not support file sending',
        );
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
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
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
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
  queue.setOnProcessDiedWithoutOutput(
    (
      groupJid: string,
      rollbackCursor: string | null,
      exitCode: number | null,
    ) => {
      const channel = findChannel(channels, groupJid);
      if (channel) {
        traceSetTyping(channel, groupJid, false, 'agent-died').catch(
          (err: any) =>
            logger.warn(
              { groupJid, err },
              'Failed to clear typing indicator after agent died',
            ),
        );
      }
      // Surface non-zero exits to the user so they don't sit watching
      // radio silence after a crash. Honours the same `sendErrorToUser`
      // config gate as the structured-error path. (kenan, 2026-04-21
      // gitignore reproducer: agent exit code=1 → bot said nothing.)
      const sendErrors = getConfig().sendErrorToUser === true;
      if (
        sendErrors &&
        channel &&
        exitCode !== null &&
        exitCode !== 0 &&
        !queue.isShuttingDown()
      ) {
        const msg =
          `⚠️ Agent process crashed (exit ${exitCode}). ` +
          `Send your message again and a fresh agent will pick it up.`;
        channel
          .sendMessage(groupJid, msg)
          .catch((err: any) =>
            logger.warn(
              { groupJid, exitCode, err },
              'Failed to deliver agent-crash notice to channel',
            ),
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
        logger.info(
          { groupJid },
          'Agent died while idle but no piped messages in flight; cursor untouched',
        );
      }
    },
  );
  recoverPendingMessages();
  startMessageLoop().catch((err: any) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err: any) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
