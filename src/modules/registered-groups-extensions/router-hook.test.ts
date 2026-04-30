import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getResolvedGroup,
  setGroupResolver,
  __resetGroupResolverForTests,
} from './router-hook.js';
import type { MessagingGroup } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';

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

describe('router setGroupResolver / getResolvedGroup', () => {
  beforeEach(() => {
    __resetGroupResolverForTests();
  });

  it('returns null when no resolver is registered', () => {
    expect(getResolvedGroup(mg, event)).toBeNull();
  });

  it('returns the resolver result when registered', () => {
    const resolver = vi.fn().mockReturnValue({
      name: 'Test Group',
      folder: 'g/test',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    });
    setGroupResolver(resolver);
    const result = getResolvedGroup(mg, event);
    expect(result).toEqual({
      name: 'Test Group',
      folder: 'g/test',
      trigger: '@bot',
      added_at: expect.any(String),
    });
    expect(resolver).toHaveBeenCalledWith(mg, event);
  });

  it('returns null when resolver returns null', () => {
    setGroupResolver(() => null);
    expect(getResolvedGroup(mg, event)).toBeNull();
  });

  it('catches resolver throws and returns null', () => {
    setGroupResolver(() => {
      throw new Error('db gone');
    });
    expect(getResolvedGroup(mg, event)).toBeNull();
  });
});
