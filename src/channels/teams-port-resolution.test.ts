import { describe, it, expect } from 'vitest';
import { resolveTeamsPort } from './teams.js';

/**
 * Port resolution for the Teams in-proc webhook listener (App Service support,
 * 2026-06-26). Azure App Service injects `PORT` and requires the process to
 * listen on it; the listener previously only honored config + legacy
 * MSTEAMS_WEBHOOK_PORT + 3978, so it never bound the platform port.
 */
describe('resolveTeamsPort', () => {
  it('explicit config port wins over everything', () => {
    expect(resolveTeamsPort(8080, { PORT: '9000', MSTEAMS_WEBHOOK_PORT: '7000' })).toBe(8080);
  });

  it('uses platform-injected PORT when no config port', () => {
    expect(resolveTeamsPort(undefined, { PORT: '9000' })).toBe(9000);
  });

  it('PORT takes precedence over legacy MSTEAMS_WEBHOOK_PORT', () => {
    expect(resolveTeamsPort(undefined, { PORT: '9000', MSTEAMS_WEBHOOK_PORT: '7000' })).toBe(9000);
  });

  it('falls back to MSTEAMS_WEBHOOK_PORT when PORT unset', () => {
    expect(resolveTeamsPort(undefined, { MSTEAMS_WEBHOOK_PORT: '7000' })).toBe(7000);
  });

  it('defaults to 3978 when nothing set', () => {
    expect(resolveTeamsPort(undefined, {})).toBe(3978);
  });

  it('ignores non-numeric PORT and falls through', () => {
    expect(resolveTeamsPort(undefined, { PORT: 'notaport', MSTEAMS_WEBHOOK_PORT: '7000' })).toBe(7000);
  });

  it('ignores non-positive PORT and falls through to default', () => {
    expect(resolveTeamsPort(undefined, { PORT: '0' })).toBe(3978);
    expect(resolveTeamsPort(undefined, { PORT: '-5' })).toBe(3978);
  });

  it('config port of 0 is treated as unset (falsy) and falls through', () => {
    expect(resolveTeamsPort(0, { PORT: '9000' })).toBe(9000);
  });
});
