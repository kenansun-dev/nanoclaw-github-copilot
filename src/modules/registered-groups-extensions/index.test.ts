import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  installRegisteredGroupsFork,
  makeRegisteredGroupsResolver,
  __resetRegisteredGroupsForkInstalledForTests,
} from './index.js';
import {
  getResolvedGroup,
  __resetGroupResolverForTests,
} from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';

vi.mock('../../db.js', () => ({
  getAllRegisteredGroups: vi.fn(),
  getRegisteredGroup: vi.fn(),
  setRegisteredGroup: vi.fn(),
  removeRegisteredGroup: vi.fn(),
}));

import { getRegisteredGroup } from '../../db.js';

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

describe('registered-groups-extensions resolver', () => {
  beforeEach(() => {
    __resetGroupResolverForTests();
    __resetRegisteredGroupsForkInstalledForTests();
    vi.mocked(getRegisteredGroup).mockReset();
  });

  it('looks up by mg.platform_id and strips the {jid} extra', () => {
    vi.mocked(getRegisteredGroup).mockReturnValue({
      jid: 'group-jid@g.us',
      name: 'Test',
      folder: 'g/test',
      trigger: '@bot',
      added_at: '2026-01-01T00:00:00Z',
    });
    const resolver = makeRegisteredGroupsResolver();
    const result = resolver(mg, event);
    expect(getRegisteredGroup).toHaveBeenCalledWith('group-jid@g.us');
    expect(result).toEqual({
      name: 'Test',
      folder: 'g/test',
      trigger: '@bot',
      added_at: '2026-01-01T00:00:00Z',
    });
    expect(result).not.toHaveProperty('jid');
  });

  it('returns null when not registered', () => {
    vi.mocked(getRegisteredGroup).mockReturnValue(undefined);
    const resolver = makeRegisteredGroupsResolver();
    expect(resolver(mg, event)).toBeNull();
  });

  it('returns null on db error', () => {
    vi.mocked(getRegisteredGroup).mockImplementation(() => {
      throw new Error('db gone');
    });
    const resolver = makeRegisteredGroupsResolver();
    expect(resolver(mg, event)).toBeNull();
  });

  it('install wires the resolver on the router (and is idempotent)', () => {
    vi.mocked(getRegisteredGroup).mockReturnValue({
      jid: 'group-jid@g.us',
      name: 'X',
      folder: 'g/x',
      trigger: 't',
      added_at: '2026-01-01T00:00:00Z',
    });
    installRegisteredGroupsFork();
    installRegisteredGroupsFork();
    const resolved = getResolvedGroup(mg, event);
    expect(resolved?.name).toBe('X');
  });
});
