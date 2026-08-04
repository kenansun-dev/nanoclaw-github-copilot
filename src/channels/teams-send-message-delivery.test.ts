import { describe, expect, it } from 'vitest';
import { TeamsChannel } from './teams.js';

describe('TeamsChannel.sendMessage delivery truthfulness', () => {
  it('rejects when the conversation reference is missing', async () => {
    const channel = Object.create(TeamsChannel.prototype) as any;
    channel.conversationRefs = new Map();
    await expect(channel.sendMessage('teams:missing', 'answer')).rejects.toThrow(/no conversation reference/i);
  });

  it('rethrows Bot Connector failure after retries/notice so cursor logic cannot mark void as delivered', async () => {
    const jid = 'teams:conversation';
    const channel = Object.create(TeamsChannel.prototype) as any;
    channel.conversationRefs = new Map([[jid, {}]]);
    channel.transport = 'tunnel';
    const err: any = new Error('BadSyntax: rejected');
    err.statusCode = 400; // permanent: sendWithRetry fails fast
    channel.adapter = {
      continueConversation: async (_ref: unknown, logic: (ctx: any) => Promise<void>) => {
        await logic({ sendActivity: async () => Promise.reject(err) });
      },
    };

    await expect(channel.sendMessage(jid, 'answer')).rejects.toBe(err);
  });
});
