/**
 * Channel-agnostic transport for ProgressDraftSession.
 *
 * The session only needs two operations: open a fresh message and edit it.
 * Both swallow errors so a transient 429 / network blip can't abort the
 * agent turn — the draft is best-effort UX, the answer is the source of
 * truth.
 */

import type { Channel } from './types-extensions.js';
import type { ProgressTransport } from './progress-draft.js';
import { logger } from './log-extensions.js';

export interface CreateProgressTransportArgs {
  channel: Channel;
  chatJid: string;
}

export function createProgressTransport(args: CreateProgressTransportArgs): ProgressTransport {
  const { channel, chatJid } = args;
  return {
    async sendDraft(text: string): Promise<string | undefined> {
      try {
        const id = await channel.sendMessage(chatJid, text);
        return typeof id === 'string' ? id : undefined;
      } catch (err) {
        logger.warn(
          { chatJid, channel: channel.name, err: (err as Error).message },
          'progress-draft: sendDraft failed (non-fatal)',
        );
        return undefined;
      }
    },
    async editDraft(msgId: string, text: string): Promise<void> {
      if (!channel.editMessage) return;
      try {
        await channel.editMessage(chatJid, msgId, text);
      } catch (err) {
        logger.warn(
          { chatJid, channel: channel.name, msgId, err: (err as Error).message },
          'progress-draft: editDraft failed (non-fatal)',
        );
      }
    },
  };
}
