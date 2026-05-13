/**
 * TUI channel — accepts connections via Unix domain socket (or named pipe on Windows).
 *
 * Protocol: newline-delimited JSON over a socket at ~/.nanoclaw/tui.sock
 *
 * Client → Server (inbound):
 *   { "type": "message", "text": "hello" }
 *   { "type": "new_session" }
 *
 * Server → Client (outbound):
 *   { "type": "reply", "text": "...", "messageId": "..." }
 *   { "type": "typing", "isTyping": true }
 *   { "type": "partial", "text": "...", "messageId": "..." }
 *   { "type": "error", "error": "..." }
 *   { "type": "connected", "assistantName": "..." }
 */

import fs from 'fs';
import net from 'net';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../log-extensions.js';
import { loadConfig } from '../config-loader.js';
import { resolveWorkspace } from '../workspace.js';
import { deriveGroupFolder } from '../chat-manager.js';
// registerGroup callback is provided via ChannelOpts
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types-extensions.js';

const TUI_JID_PREFIX = 'tui:';
// Single stable jid shared by every TUI connection. Each `nanoclaw tui`
// session attaches to the same registered chat instead of creating a new
// `tui:1`, `tui:2`, ... entry that pollutes nanoclaw.json + status/doctor.
// All TUI clients share the same isMain DM session via the share-main
// collapse rule (see src/session-routing.ts).
const TUI_JID = `${TUI_JID_PREFIX}default`;
const SOCK_NAME = process.platform === 'win32' ? '\\\\.\\pipe\\nanoclaw-tui' : 'tui.sock';

interface TuiClient {
  id: string;
  socket: net.Socket;
  buffer: string;
}

export class TuiChannel implements Channel {
  name = 'tui';

  private server: net.Server | null = null;
  private clients = new Map<string, TuiClient>();
  private opts: ChannelOpts;
  private sockPath: string;
  private nextClientId = 1;
  private connected = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const ws = resolveWorkspace();
    this.sockPath = process.platform === 'win32' ? SOCK_NAME : path.join(ws, 'tui.sock');
  }

  async connect(): Promise<void> {
    // Clean up stale socket file
    if (process.platform !== 'win32' && fs.existsSync(this.sockPath)) {
      try {
        fs.unlinkSync(this.sockPath);
      } catch {
        /* ignore */
      }
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.sockPath, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.sockPath, 0o600);
          } catch {
            /* ignore */
          }
        }
        logger.info({ path: this.sockPath }, 'TUI channel listening');
        this.connected = true;
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = String(this.nextClientId++);
    // Every TUI client attaches to the same stable jid so we don't
    // proliferate tui:1, tui:2, ... entries in nanoclaw.json/db on each
    // connect. clientId is kept locally for log correlation only.
    const jid = TUI_JID;
    const client: TuiClient = { id: clientId, socket, buffer: '' };
    this.clients.set(clientId, client);

    logger.info({ clientId, jid }, 'TUI client connected');

    // Auto-register the TUI group on the FIRST connect ever (or first
    // connect after this process started). Idempotent: already-present
    // jid skips registration.
    //
    // v2 cleanup (PR-C step 9): the TUI is a single-agent attach. Pick the
    // agent from `TUI_AGENT_ID` env (override) or fall back to the first
    // entry in `agents.list[]`. The legacy `isMain: true` on the group
    // is retained ONLY so the share-main DM collapse + mount-perm code in
    // `db.ts`/`session-routing.ts` keeps a stable session folder until
    // those code paths get rewritten in PR-D. It no longer drives routing
    // — v2 routing goes through bindings.
    const config = loadConfig();
    const assistantName = config.agents?.defaults?.name || ASSISTANT_NAME;
    const agentList: Array<{ id: string }> = (config as any).agents?.list ?? [];
    const tuiAgentId = process.env.TUI_AGENT_ID || (agentList.length > 0 ? agentList[0].id : undefined);

    const existingGroups = this.opts.registeredGroups();
    if (!existingGroups[jid] && this.opts.registerGroup) {
      const folder = deriveGroupFolder(jid, { isMain: true });
      const tuiGroup = {
        name: 'tui',
        folder,
        isMain: true,
        trigger: '',
        added_at: new Date().toISOString(),
        ...(tuiAgentId ? { agentId: tuiAgentId } : {}),
      };
      this.opts.registerGroup(jid, tuiGroup);
      logger.info({ jid, folder, agentId: tuiAgentId }, 'Auto-registered TUI group');
    }

    // Notify chat metadata. isGroup=false so the share-main collapse
    // rule treats this as a DM and merges it onto the canonical session.
    this.opts.onChatMetadata(jid, new Date().toISOString(), 'tui', 'tui', false);

    // Send connected message
    this.sendJson(socket, {
      type: 'connected',
      assistantName,
      clientId,
    });

    socket.on('data', (data) => {
      client.buffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = client.buffer.indexOf('\n')) !== -1) {
        const line = client.buffer.substring(0, newlineIdx).trim();
        client.buffer = client.buffer.substring(newlineIdx + 1);
        if (line) this.handleMessage(client, jid, line);
      }
    });

    socket.on('close', () => {
      logger.info({ clientId }, 'TUI client disconnected');
      this.clients.delete(clientId);
    });

    socket.on('error', (err) => {
      logger.warn({ clientId, err: err.message }, 'TUI client error');
      this.clients.delete(clientId);
    });
  }

  private handleMessage(client: TuiClient, jid: string, line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendJson(client.socket, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'message':
        if (!msg.text?.trim()) {
          this.sendJson(client.socket, {
            type: 'error',
            error: 'Empty message',
          });
          return;
        }
        // Route to the main message handler
        const newMsg: NewMessage = {
          id: msg.id || `tui-in-${Date.now()}`,
          chat_jid: jid,
          sender: 'user',
          sender_name: 'user',
          content: msg.text.trim(),
          timestamp: new Date().toISOString(),
          is_from_me: false,
        };
        this.opts.onMessage(jid, newMsg);
        break;

      case 'new_session':
        this.sendJson(client.socket, { type: 'session_reset' });
        break;

      default:
        this.sendJson(client.socket, {
          type: 'error',
          error: `Unknown type: ${msg.type}`,
        });
    }
  }

  async sendMessage(jid: string, text: string): Promise<string | void> {
    const clients = this.getClientsForJid(jid);
    if (clients.length === 0) return;
    const messageId = `tui-msg-${Date.now()}`;
    for (const client of clients) {
      this.sendJson(client.socket, { type: 'reply', text, messageId });
    }
    return messageId;
  }

  async editMessage(jid: string, messageId: string, text: string): Promise<string | void> {
    const clients = this.getClientsForJid(jid);
    if (clients.length === 0) return;
    // Distinguish streaming partial (still accumulating, has ◌ marker)
    // from final edit (replacing progressive message with final content).
    // Final edits should emit as 'reply' so TUI renders a complete line
    // with trailing newlines, not as an in-place overwrite.
    const isStreaming = text.includes('◌');
    const type = isStreaming ? 'partial' : 'reply';
    for (const client of clients) {
      this.sendJson(client.socket, { type, text, messageId });
    }
    return messageId;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const clients = this.getClientsForJid(jid);
    for (const client of clients) {
      this.sendJson(client.socket, { type: 'typing', isTyping });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(TUI_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.clients.values()) {
      try {
        client.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      if (process.platform !== 'win32' && fs.existsSync(this.sockPath)) {
        try {
          fs.unlinkSync(this.sockPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private getClientsForJid(jid: string): TuiClient[] {
    // All TUI clients share the canonical jid. Broadcast outbound
    // messages to every attached client so multiple `nanoclaw tui`
    // sessions can observe the same conversation.
    if (jid !== TUI_JID) return [];
    return Array.from(this.clients.values());
  }

  /** Legacy single-client lookup, kept for callers outside the broadcast path. */
  private getClientByJid(jid: string): TuiClient | undefined {
    return this.getClientsForJid(jid)[0];
  }

  private sendJson(socket: net.Socket, obj: object): void {
    try {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(obj) + '\n');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to send to TUI client');
    }
  }
}

// Self-register: TUI channel is always available (no config needed)
registerChannel('tui', (opts) => {
  return new TuiChannel(opts);
});
