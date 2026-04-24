import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      process.env.NANOCLAW_WORKSPACE = tempDir;
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
      delete process.env.NANOCLAW_WORKSPACE;
    }
  });

  it('adds session-level override columns to legacy sessions table', async () => {
    // PR #26 (2026-04-24): /think, /model, /reasoning slash commands write
    // session-level overrides via these new columns. Verify the migration
    // adds them on top of an old (composite-PK already, but no override
    // columns) sessions table.
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-db-overrides-'),
    );

    try {
      process.chdir(tempDir);
      process.env.NANOCLAW_WORKSPACE = tempDir;
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      // Old shape: composite PK already, no override columns.
      legacyDb.exec(`
        CREATE TABLE sessions (
          group_folder TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'anthropic',
          session_id TEXT NOT NULL,
          PRIMARY KEY (group_folder, provider)
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO sessions (group_folder, provider, session_id) VALUES (?, ?, ?)`,
        )
        .run('grp', 'github-copilot', 'old-session-id');
      legacyDb.close();

      vi.resetModules();
      const {
        initDatabase,
        getSessionOverrides,
        setSessionOverride,
        getSession,
        setSession,
        _closeDatabase,
      } = await import('./db.js');

      initDatabase();

      // Existing row preserved.
      expect(getSession('grp', 'github-copilot')).toBe('old-session-id');
      // Migration added the override columns; defaults to no overrides.
      expect(getSessionOverrides('grp', 'github-copilot')).toEqual({});

      // Setting an override on the existing row works without nuking session_id.
      setSessionOverride('grp', 'think_level', 'high', 'github-copilot');
      expect(getSessionOverrides('grp', 'github-copilot')).toEqual({
        thinkLevel: 'high',
      });
      expect(getSession('grp', 'github-copilot')).toBe('old-session-id');

      // setSession on an existing row preserves the override (uses ON CONFLICT
      // UPDATE rather than REPLACE).
      setSession('grp', 'new-session-id', 'github-copilot');
      expect(getSession('grp', 'github-copilot')).toBe('new-session-id');
      expect(getSessionOverrides('grp', 'github-copilot')).toEqual({
        thinkLevel: 'high',
      });

      // Setting override on a fresh group creates a placeholder row.
      setSessionOverride(
        'newgrp',
        'model',
        'claude-opus-4.6',
        'github-copilot',
      );
      expect(getSessionOverrides('newgrp', 'github-copilot')).toEqual({
        model: 'claude-opus-4.6',
      });

      // Clearing an override sets it back to undefined.
      setSessionOverride('grp', 'think_level', null, 'github-copilot');
      expect(getSessionOverrides('grp', 'github-copilot')).toEqual({});

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
      delete process.env.NANOCLAW_WORKSPACE;
    }
  });
});
