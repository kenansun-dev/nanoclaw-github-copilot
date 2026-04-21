import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
import { runAgentForChat, IS_GHC_PROVIDER } from './config-extensions.js';
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
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  formatConversationContext,
} from './router.js';
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
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
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
  let lastFinalMsgId: string | undefined;
  // Thinking message state (separate from answer progressive message)

  try {
    const output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback

      // Skip thinking-only deltas (will be merged into final result)
      if (result.thinking && !result.result) {
        return;
      }

      if (result.result) {
        // Merge thinking into result as one message (only if showThinking is enabled)
        let thinkingParseMode: 'HTML' | 'Markdown' | undefined;
        if (
          result.thinking &&
          !result.partial &&
          getConfig().agents?.defaults?.showThinking
        ) {
          const tp = formatThinkingForChannel(result.thinking, chatJid);
          if (tp) {
            thinkingParseMode = tp.parseMode;
            // Don't escape the answer — let Telegram fallback handle parse errors
            result.result = tp.text + '\n\n' + result.result;
          }
        }
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

        if (result.partial && channel.editMessage) {
          // Delta/partial: accumulate and edit existing message
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
            // Subsequent partial — edit existing message
            await channel.editMessage(
              chatJid,
              progressiveMsgId,
              text + ' ◌',
              sendOpts,
            );
          }
        } else {
          // Final message (or channel doesn't support edit)
          await traceSetTyping(channel, chatJid, false, 'final-output');
          if (progressiveMsgId && channel.editMessage) {
            // Replace the progressive message with final content
            await channel.editMessage(
              chatJid,
              progressiveMsgId,
              text,
              sendOpts,
            );
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
            await channel.editMessage(chatJid, lastFinalMsgId, text, sendOpts);
          } else {
            const msgId = await channel.sendMessage(chatJid, text, sendOpts);
            lastFinalMsgId = typeof msgId === 'string' ? msgId : undefined;
          }
          progressiveMsgId = undefined;
          progressiveText = '';
          outputSentToUser = true;
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
  const sessionId = sessions[group.folder];

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
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
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
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
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
 * Format thinking/reasoning content for channel display.
 * Returns structured data so callers can set parse mode correctly.
 */
function formatThinkingForChannel(
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

async function main(): Promise<void> {
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
    (groupJid: string, rollbackCursor: string | null) => {
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
