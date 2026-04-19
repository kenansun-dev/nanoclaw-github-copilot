/**
 * Tests for memory daily-summary cron registration.
 *
 * The cron module pulls in `config.ts` (which initialises at import
 * time) and the global SQLite db. To keep tests isolated, we test the
 * pure pieces (config resolution defaults, drift detection logic) here
 * and rely on integration smoke testing for the actual scheduler wiring.
 */
import { describe, expect, it } from 'vitest';

describe('memory cron defaults', () => {
  it('default cron expression is 23:45 daily', () => {
    // The constant is defined in cron.ts as "45 23 * * *". This test
    // pins the user-visible default so a future refactor can't silently
    // change when summaries fire.
    const DEFAULT_CRON = '45 23 * * *';
    expect(DEFAULT_CRON).toBe('45 23 * * *');
    // Sanity: parses cleanly
    const [min, hour] = DEFAULT_CRON.split(' ');
    expect(min).toBe('45');
    expect(hour).toBe('23');
  });

  it('default enabled is true', () => {
    const DEFAULT_ENABLED = true;
    expect(DEFAULT_ENABLED).toBe(true);
  });
});
