export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  /**
   * Number of consecutive scheduler ticks that have failed to find this
   * task's group_folder in `registeredGroups`. Reset to 0 on a successful
   * lookup. When it reaches `MAX_CONSECUTIVE_GROUP_MISSING` the scheduler
   * auto-pauses the task with a clear last_result. Migrated column;
   * defaults to 0 for pre-migration rows.
   */
  consecutive_group_missing?: number;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

/**
 * Handle returned by `Channel.streamMessage()`. Lifecycle:
 *   open → chunk(cumulativeText) × N → end(finalText)
 *   open → cancel()  (no final published)
 *
 * `chunk` receives the **cumulative** text accumulated so far (not a
 * delta). This matches how the dispatcher already accumulates partial
 * text in `progressiveText` and avoids the channel re-implementing
 * delta state. Implementations may compress / coalesce chunks before
 * sending if their platform rate-limits.
 *
 * `end` returns the platform's final message id (if any) so callers
 * can record `lastFinalMsgId` for subsequent multi-final dispatch.
 *
 * Implementations MUST tolerate `end` or `cancel` being called once;
 * subsequent calls should be no-ops.
 */
export interface StreamHandle {
  chunk(cumulativeText: string): Promise<void>;
  end(finalText: string): Promise<string | void>;
  cancel(): Promise<void>;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: { parseMode?: 'HTML' | 'Markdown' },
  ): Promise<string | void>;
  /** Send a rich card (Adaptive Card on Teams, falls back to text on others) */
  sendCard?(jid: string, card: object, fallbackText: string): Promise<void>;
  /** Send a file to a chat */
  sendFile?(jid: string, filePath: string, filename?: string): Promise<void>;
  /** Edit a previously sent message */
  editMessage?(
    jid: string,
    messageId: string,
    text: string,
    options?: { parseMode?: 'HTML' | 'Markdown' },
  ): Promise<string | void>;
  /**
   * Delete a previously sent message. Used by `flash` showThinking mode
   * to remove the streamed thinking preview once the answer arrives.
   * Channels that don't support deletion should leave this undefined;
   * dispatcher falls back to editing the message to a single space.
   */
  deleteMessage?(jid: string, messageId: string): Promise<void>;
  /**
   * When true, multiple final outputs in a single agent turn (e.g.
   * text → tool call → more text) are delivered as separate new messages
   * instead of editing the previous final message. Channels where in-place
   * edits feel natural (Telegram) leave this false; channels where edits
   * silently overwrite history (Teams) should set this true so each agent
   * reply stays visible.
   *
   * This does NOT affect progressive streaming partials — those still
   * accumulate via editMessage on the same in-flight message UNLESS the
   * channel also sets `usesNativeStreaming` (see below).
   */
  prefersNewMessageForFinal?: boolean;
  /**
   * When true, the dispatcher routes streaming partials through
   * `streamMessage()` instead of the legacy `sendMessage(partial+◌)` +
   * `editMessage(partial→final)` path. Channels set this when their
   * platform offers a native streaming protocol (e.g. Teams' streaming
   * AI messages, where `entities[].streamType` lets the client render
   * a single live bubble without per-chunk message edits).
   *
   * Why a separate flag from `prefersNewMessageForFinal`: the two
   * concerns are independent. A channel might want native streaming
   * (this flag) AND want subsequent finals to be new messages
   * (`prefersNewMessageForFinal`), or either one alone. Conflating
   * them blocked the original `prefersNewMessageForFinal` docstring
   * which explicitly said it did not touch partials.
   *
   * Background: the legacy `editMessage(partial→final)` path on Teams
   * relied on `updateActivity()` succeeding across IPC turn boundaries
   * and stale conversation refs. When it failed, the catch block fell
   * back to `sendMessage()` and produced visible duplicate messages.
   * Native streaming sidesteps `updateActivity` entirely.
   */
  usesNativeStreaming?: boolean;
  /**
   * Open a native streaming session for `jid`. Required when
   * `usesNativeStreaming` is true; ignored otherwise.
   *
   * The returned handle exposes `chunk(cumulativeText)` for in-flight
   * partial updates, `end(finalText)` to publish the canonical final
   * message (and tear down the stream), and `cancel()` to abort the
   * stream without publishing a final.
   *
   * Implementations are responsible for serializing outbound activities
   * (single in-flight at a time) and for graceful degradation when the
   * underlying platform rejects streaming (e.g. emit a single `end`
   * message instead).
   */
  streamMessage?(
    jid: string,
    options?: { parseMode?: 'HTML' | 'Markdown' },
  ): Promise<StreamHandle>;
  reactToMessage?(
    jid: string,
    emoji: string,
    messageId?: string,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

// ============================================================================
// Upstream v2 types (lifted from upstream/feat/migrate-from-v1:src/types.ts).
// Co-exist with fork v1 types above. Fork-only types: AdditionalMount,
// MountAllowlist, AllowedRoot, ContainerConfig, RegisteredGroup, NewMessage,
// ScheduledTask, TaskRunLog, StreamHandle, Channel, OnInboundMessage,
// OnChatMetadata. v2 dispatcher / module surface types follow.
// ============================================================================

// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   */
  denied_at?: string | null;
  created_at: string;
}

// ── Identity & privilege ──

export interface User {
  id: string;
  kind: string; // 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  created_at: string;
}

// ── Pending approvals (central DB) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string; // JSON
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string;
  options_json: string;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}
