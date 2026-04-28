import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSenderAllowlistGate } from './index.js';
import type { MessagingGroup } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';

vi.mock('../../sender-allowlist.js', () => {
  const actual: Record<string, ReturnType<typeof vi.fn>> = {
    isSenderAllowed: vi.fn(),
    loadSenderAllowlist: vi.fn(),
  };
  return actual;
});

import {
  isSenderAllowed,
  loadSenderAllowlist,
} from '../../sender-allowlist.js';

const mg: MessagingGroup = {
  id: 'mg-1',
  channel_type: 'whatsapp',
  platform_id: 'group-jid@g.us',
  name: 'Test',
  is_group: 1,
  unknown_sender_policy: 'strict',
  created_at: new Date().toISOString(),
};

const event: InboundEvent = {
  channelType: 'whatsapp',
  platformId: '11111@s.whatsapp.net',
  threadId: null,
  message: {
    id: 'm-1',
    kind: 'chat',
    content: '{}',
    timestamp: new Date().toISOString(),
  },
};

describe('sender-allowlist-fork access gate', () => {
  beforeEach(() => {
    vi.mocked(isSenderAllowed).mockReset();
    vi.mocked(loadSenderAllowlist).mockReset();
    vi.mocked(loadSenderAllowlist).mockReturnValue({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
  });

  it('allows when allowlist permits the sender (using userId)', () => {
    vi.mocked(isSenderAllowed).mockReturnValue(true);
    const gate = makeSenderAllowlistGate();
    const result = gate(event, 'user-42', mg, 'ag-1');
    expect(result).toEqual({ allowed: true });
    expect(isSenderAllowed).toHaveBeenCalledWith(
      'group-jid@g.us',
      'user-42',
      expect.any(Object),
    );
  });

  it('falls back to event.platformId when userId is null', () => {
    vi.mocked(isSenderAllowed).mockReturnValue(true);
    const gate = makeSenderAllowlistGate();
    const result = gate(event, null, mg, 'ag-1');
    expect(result).toEqual({ allowed: true });
    expect(isSenderAllowed).toHaveBeenCalledWith(
      'group-jid@g.us',
      '11111@s.whatsapp.net',
      expect.any(Object),
    );
  });

  it('denies when the allowlist rejects the sender', () => {
    vi.mocked(isSenderAllowed).mockReturnValue(false);
    const gate = makeSenderAllowlistGate();
    const result = gate(event, 'user-99', mg, 'ag-1');
    expect(result).toEqual({
      allowed: false,
      reason: 'sender-allowlist denied',
    });
  });

  it('allows fail-open when loadSenderAllowlist throws', () => {
    vi.mocked(loadSenderAllowlist).mockImplementation(() => {
      throw new Error('disk gone');
    });
    const gate = makeSenderAllowlistGate();
    const result = gate(event, 'user-42', mg, 'ag-1');
    expect(result).toEqual({ allowed: true });
  });
});
