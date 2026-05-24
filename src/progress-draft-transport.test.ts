/**
 * Tests for createProgressTransport — the thin Channel-adapter that
 * ProgressDraftSession uses to open + edit the draft message.
 *
 * The transport MUST swallow channel errors (a 429 / network blip while
 * editing a best-effort progress bubble must not abort the agent turn).
 */

import { describe, it, expect, vi } from 'vitest';
import { createProgressTransport } from './progress-draft-transport.js';
import type { Channel } from './types-extensions.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'test',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('msg-1'),
    editMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Channel;
}

describe('createProgressTransport', () => {
  it('sendDraft delegates to channel.sendMessage and returns the message id', async () => {
    const channel = makeChannel();
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    const id = await t.sendDraft('hello');
    expect(id).toBe('msg-1');
    expect(channel.sendMessage).toHaveBeenCalledWith('tg:42', 'hello');
  });

  it('sendDraft returns undefined when channel.sendMessage returns non-string', async () => {
    const channel = makeChannel({ sendMessage: vi.fn().mockResolvedValue(undefined) });
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    await expect(t.sendDraft('x')).resolves.toBeUndefined();
  });

  it('sendDraft swallows errors and returns undefined', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    await expect(t.sendDraft('x')).resolves.toBeUndefined();
  });

  it('editDraft calls channel.editMessage with msgId + text', async () => {
    const channel = makeChannel();
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    await t.editDraft('msg-1', 'new text');
    expect(channel.editMessage).toHaveBeenCalledWith('tg:42', 'msg-1', 'new text');
  });

  it('editDraft is a no-op when channel lacks editMessage capability', async () => {
    const channel = makeChannel({ editMessage: undefined });
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    await expect(t.editDraft('msg-1', 'x')).resolves.toBeUndefined();
  });

  it('editDraft swallows errors (best-effort, never aborts agent turn)', async () => {
    const channel = makeChannel({
      editMessage: vi.fn().mockRejectedValue(new Error('rate limit')),
    });
    const t = createProgressTransport({ channel, chatJid: 'tg:42' });
    await expect(t.editDraft('msg-1', 'x')).resolves.toBeUndefined();
  });
});
