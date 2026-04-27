/**
 * Registered groups (fork add-on) module skeleton — verifies the fork
 * helpers are reachable through the v2 module path. Real router
 * wiring is deferred to B.5.
 */
import { describe, it, expect } from 'vitest';

import { registeredGroupsFork } from './index.js';

describe('registered-groups-fork module skeleton', () => {
  it('re-exports the fork registered-group helpers', () => {
    expect(typeof registeredGroupsFork.getAllRegisteredGroups).toBe(
      'function',
    );
    expect(typeof registeredGroupsFork.getRegisteredGroup).toBe('function');
    expect(typeof registeredGroupsFork.setRegisteredGroup).toBe('function');
    expect(typeof registeredGroupsFork.removeRegisteredGroup).toBe('function');
  });
});
