import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './log-extensions.js';
import { collapseMainDmFolder } from './session-routing.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types-extensions.js';

let db: Database.Database;

/**
 * Lookup `chats.is_group` for a single jid. Returns undefined when the
 * row is missing or the column is NULL (channel adapter hasn't recorded
 * the metadata yet). Used by the collapse-on-read path so we only merge
 * isMain DMs onto a shared session when we *know* they are DMs.
 */
function getChatIsGroup(jid: string): boolean | undefined {
  if (!db) return undefined;
  const row = db.prepare('SELECT is_group FROM chats WHERE jid = ?').get(jid) as
    | { is_group: number | null }
    | undefined;
  if (!row || row.is_group === null) return undefined;
  return row.is_group === 1;
}

/**
 * Batch-fetch `chats.is_group` for ALL chats in one query. Used by
 * `getAllRegisteredGroups` to avoid N+1 SQL when collapsing folders
 * for many registered groups at once.
 */
export function getAllChatIsGroup(): Map<string, boolean | undefined> {
  const out = new Map<string, boolean | undefined>();
  if (!db) return out;
  const rows = db.prepare('SELECT jid, is_group FROM chats').all() as Array<{
    jid: string;
    is_group: number | null;
  }>;
  for (const r of rows) {
    out.set(r.jid, r.is_group === null ? undefined : r.is_group === 1);
  }
  return out;
}

/**
 * Lazy chat-config snapshot getter. Returns the full `chats` map from
 * nanoclaw.json or undefined if config can't be loaded. Wrapped so we
 * can call it once outside hot loops in `getAllRegisteredGroups`.
 */
function loadChatsConfigSnapshot(): Record<string, { agentId?: string }> | undefined {
  try {
    // Lazy require to avoid pulling config-loader during early db init.
    // config-loader does not import from db.ts, so this is acyclic.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadConfig } = require('./config-loader.js');
    return loadConfig().chats as Record<string, { agentId?: string }> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the canonical (collapsed) folder for a registered group.
 * Loads the chat config lazily so the agentId can drive per-agent collapse.
 * Falls back to the raw folder if config can't be loaded for any reason.
 *
 * Single-row path: used by `getRegisteredGroup`. For batch reads use
 * `resolveCollapsedFolderBatch` to avoid N+1 SQL/fs reads.
 */
function resolveCollapsedFolder(group: RegisteredGroup & { jid: string }): string {
  const chats = loadChatsConfigSnapshot();
  return collapseMainDmFolder(group.folder, chats?.[group.jid], getChatIsGroup(group.jid));
}

/**
 * Batch-friendly collapse: caller pre-fetches the chats config map and
 * is_group map once, then this just does pure lookup per row.
 */
function resolveCollapsedFolderBatch(
  group: RegisteredGroup & { jid: string },
  chatsConfig: Record<string, { agentId?: string }> | undefined,
  isGroupMap: Map<string, boolean | undefined>,
): string {
  return collapseMainDmFolder(group.folder, chatsConfig?.[group.jid], isGroupMap.get(group.jid));
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      consecutive_group_missing INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      session_id TEXT NOT NULL,
      think_level TEXT,
      model TEXT,
      show_thinking TEXT,
      PRIMARY KEY (group_folder, provider)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs).
  // NOTE (2026-05-12, PR #46): context_mode is DEPRECATED. Upstream v2
  // dropped the field entirely (`modules/scheduling/`) and we've followed
  // suit at the runtime level: task-scheduler.ts always treats tasks as
  // isolated regardless of stored value. The column is preserved here so
  // SELECT * keeps working and downgrades survive; a future
  // fork-cleanup migration may drop it. New rows still default 'isolated'.
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch {
    /* column already exists */
  }

  // Migration: sessions table from (group_folder PK) to (group_folder, provider PK)
  // Old rows are assumed to be 'anthropic' since CC was the original default.
  // Existing GHC sessions in old schema get tagged 'anthropic' which may cause
  // a one-time fresh session on next GHC use — acceptable trade-off vs trying
  // to retro-detect provider from session UUID format.
  try {
    const cols = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    const hasProvider = cols.some((c) => c.name === 'provider');
    if (!hasProvider) {
      // Rebuild table with composite PK (SQLite can't change PK in place)
      database.exec(`
        CREATE TABLE sessions_new (
          group_folder TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'anthropic',
          session_id TEXT NOT NULL,
          PRIMARY KEY (group_folder, provider)
        );
        INSERT INTO sessions_new (group_folder, provider, session_id)
          SELECT group_folder, 'anthropic', session_id FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
    }
  } catch (err) {
    // If migration fails (e.g. fresh DB just created with new schema), ignore.
    void err;
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add session-level slash overrides (think_level, model, show_thinking).
  // Adopts OpenClaw's per-session-override + global-default model: slash
  // commands write here by default; --default flag writes global config.
  // See PR #26 (2026-04-24).
  for (const col of ['think_level', 'model', 'show_thinking']) {
    try {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
    } catch {
      /* column already exists */
    }
  }

  // Add consecutive_group_missing column for orphan-task detection.
  // Tracks how many consecutive scheduler ticks have failed to find
  // the task's group in `registeredGroups`. Used to auto-pause stale
  // tasks whose group was unregistered (TUI session ended, channel
  // logged out, etc.) so the scheduler stops spamming once-per-minute
  // "Group not found" errors. See task-scheduler.runTask().
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN consecutive_group_missing INTEGER DEFAULT 0`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`);
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`);
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`);
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db.prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`).get() as
    | { last_message_time: string }
    | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

/**
 * Get a single message by its ID and chat JID.
 * Used for resolving reply/quote context (e.g. Teams replyToId).
 */
export function getMessageById(
  chatJid: string,
  messageId: string,
): { content: string; sender_name: string } | undefined {
  const row = db
    .prepare('SELECT content, sender_name FROM messages WHERE id = ? AND chat_jid = ?')
    .get(messageId, chatJid) as { content: string; sender_name: string } | undefined;
  return row;
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * Get recent conversation messages (both user and agent) for context.
 */
/**
 * Get recent conversation messages (both user and agent) for context.
 * Fetches up to maxMessages, then truncates to fit within maxTokens.
 * Token estimate: ~4 characters per token.
 */
export function getRecentConversation(
  chatJid: string,
  maxMessages: number = 500,
  maxTokens: number = 150000,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const messages = db.prepare(sql).all(chatJid, maxMessages) as NewMessage[];

  // Truncate from oldest to fit within token budget
  let totalChars = 0;
  let startIdx = 0;
  // Calculate total chars
  for (const m of messages) totalChars += (m.content?.length || 0) + 50; // +50 for envelope
  // Remove oldest messages until we fit
  const maxChars = maxTokens * 4; // ~4 chars per token
  while (startIdx < messages.length && totalChars > maxChars) {
    totalChars -= (messages[startIdx].content?.length || 0) + 50;
    startIdx++;
  }
  return messages.slice(startIdx);
}

export function getLastBotMessageTimestamp(chatJid: string, botPrefix: string): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC')
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'script' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'consecutive_group_missing'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.consecutive_group_missing !== undefined) {
    fields.push('consecutive_group_missing = ?');
    values.push(updates.consecutive_group_missing);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Atomically increment `consecutive_group_missing` and return the new value.
 * Used by the scheduler to track stale tasks whose group has been
 * unregistered. See task-scheduler.runTask() for the policy that consumes
 * this counter (auto-pause after MAX_CONSECUTIVE_GROUP_MISSING).
 */
export function incrementConsecutiveGroupMissing(id: string): number {
  const row = db
    .prepare(
      `UPDATE scheduled_tasks
       SET consecutive_group_missing = COALESCE(consecutive_group_missing, 0) + 1
       WHERE id = ?
       RETURNING consecutive_group_missing`,
    )
    .get(id) as { consecutive_group_missing: number } | undefined;
  return row?.consecutive_group_missing ?? 0;
}

/**
 * Reset `consecutive_group_missing` to 0. Called by the scheduler when a
 * previously-missing group is found again, so a transient gap (e.g. quick
 * service restart) does not eventually pause an otherwise-healthy task.
 */
export function clearConsecutiveGroupMissing(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET consecutive_group_missing = 0 WHERE id = ?`).run(id);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db
    .prepare('SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?')
    .all(taskId, limit) as TaskRunLog[];
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM router_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(key, value);
}

// --- Session accessors ---

/**
 * Get the agent CLI session id for a (group, provider) tuple.
 *
 * Each provider stores its sessions in a different on-disk location
 * (CC: ~/.claude/sessions/, GHC: ~/.copilot/sessions/), so a sessionId
 * from one provider is meaningless to the other. We key by both so a
 * group can independently resume CC and GHC sessions when its bound
 * agent is switched.
 */
export function getSession(groupFolder: string, provider: string = 'anthropic'): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ? AND provider = ?')
    .get(groupFolder, provider) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string, provider: string = 'anthropic'): void {
  // Preserve any existing session-level overrides (think_level, model,
  // show_thinking) by using INSERT … ON CONFLICT instead of REPLACE,
  // which would NULL them out on every session refresh.
  db.prepare(
    `INSERT INTO sessions (group_folder, provider, session_id)
       VALUES (?, ?, ?)
     ON CONFLICT(group_folder, provider)
       DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, provider, sessionId);
}

/**
 * Per-session slash-command overrides. Each row may carry a think_level /
 * model / show_thinking value that takes precedence over global config
 * defaults for THAT chat's runtime invocations. NULL = inherit global default.
 */
export interface SessionOverrides {
  thinkLevel?: string;
  model?: string;
  showThinking?: string;
}

export function getSessionOverrides(groupFolder: string, provider: string = 'anthropic'): SessionOverrides {
  const row = db
    .prepare('SELECT think_level, model, show_thinking FROM sessions WHERE group_folder = ? AND provider = ?')
    .get(groupFolder, provider) as
    | {
        think_level: string | null;
        model: string | null;
        show_thinking: string | null;
      }
    | undefined;
  if (!row) return {};
  return {
    thinkLevel: row.think_level ?? undefined,
    model: row.model ?? undefined,
    showThinking: row.show_thinking ?? undefined,
  };
}

/**
 * Set a single session-level override. Pass `null` to clear (inherit global).
 * Auto-creates the row if no session exists yet (with a placeholder session_id
 * that will be replaced on next createSession).
 */
export function setSessionOverride(
  groupFolder: string,
  field: 'think_level' | 'model' | 'show_thinking',
  value: string | null,
  provider: string = 'anthropic',
): void {
  // Insert a placeholder row if none exists. The placeholder session_id
  // will be overwritten by setSession() on the next runner createSession.
  // We use a sentinel UUID so a stale row with no real session can be
  // distinguished from a live one if needed.
  db.prepare(
    `INSERT INTO sessions (group_folder, provider, session_id, ${field})
       VALUES (?, ?, '__pending__', ?)
     ON CONFLICT(group_folder, provider)
       DO UPDATE SET ${field} = excluded.${field}`,
  ).run(groupFolder, provider, value);
}

export function deleteSession(groupFolder: string, provider?: string): void {
  if (provider) {
    db.prepare('DELETE FROM sessions WHERE group_folder = ? AND provider = ?').run(groupFolder, provider);
  } else {
    // Provider omitted = clear all providers for this group (legacy behavior)
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
  }
}

/**
 * Returns all sessions as a nested map: groupFolder → provider → sessionId.
 *
 * Older callers expecting `Record<groupFolder, sessionId>` should migrate
 * to use `getSession(folder, provider)` directly. The flat shape couldn't
 * represent dual-provider state.
 */
export function getAllSessions(): Record<string, Record<string, string>> {
  const rows = db.prepare('SELECT group_folder, provider, session_id FROM sessions').all() as Array<{
    group_folder: string;
    provider: string;
    session_id: string;
  }>;
  const result: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (!result[row.group_folder]) result[row.group_folder] = {};
    result[row.group_folder][row.provider] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(jid: string): (RegisteredGroup & { jid: string }) | undefined {
  const row = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn({ jid: row.jid, folder: row.folder }, 'Skipping registered group with invalid folder');
    return undefined;
  }
  const baseGroup: RegisteredGroup & { jid: string } = {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
  // Collapse-on-read: default-agent DMs share a canonical session per agent.
  // Folder pattern (`main(-<agent>)?-<channel>-<8hex>`) drives detection.
  // See src/session-routing.ts and features/dm-session-sharing.md.
  return { ...baseGroup, folder: resolveCollapsedFolder(baseGroup) };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  // I-1-safe (2026-05-15): stopped writing v1 `is_main` column. Reads still
  // surface it via `row.is_main` for backward compat, but the source of
  // truth is now v2-master via `isMainDualRead`. Schema/column intentionally
  // retained — drop will come in a later bucket.
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

/**
 * Remove a registered group from the DB.
 * Returns true if a row was deleted, false if no such jid existed.
 * Symmetric to `setRegisteredGroup`; needed by `chat remove` so the
 * config↔DB dual-store doesn't get re-populated by reconcile-on-CLI.
 */
export function removeRegisteredGroup(jid: string): boolean {
  const info = db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
  return info.changes > 0;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  // Pre-fetch chats.is_group + nanoclaw.json once so the per-row
  // collapse stays O(1). Avoids N+1 SQL/fs reads when many chats
  // are registered.
  const isGroupMap = getAllChatIsGroup();
  const chatsConfig = loadChatsConfigSnapshot();
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn({ jid: row.jid, folder: row.folder }, 'Skipping registered group with invalid folder');
      continue;
    }
    const baseGroup: RegisteredGroup = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
    // Collapse-on-read: default-agent DMs share a canonical session per agent.
    // Folder pattern (`main(-<agent>)?-<channel>-<8hex>`) drives detection.
    // See src/session-routing.ts and features/dm-session-sharing.md.
    result[row.jid] = {
      ...baseGroup,
      folder: resolveCollapsedFolderBatch({ ...baseGroup, jid: row.jid }, chatsConfig, isGroupMap),
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState('last_agent_timestamp', JSON.stringify(routerState.last_agent_timestamp));
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<string, string> | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      // Old sessions.json predates per-provider sessions — assume CC
      // since CC was the original (and only) provider at that time.
      setSession(folder, sessionId, 'anthropic');
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<string, RegisteredGroup> | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Skipping migrated registered group with invalid folder');
      }
    }
  }
}
