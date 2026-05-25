/**
 * Tests for resolveProgressStreamingForChannel — the per-channel
 * `streaming.mode` + `streaming.progress` config reader for the
 * progress-draft lane (proposal docs/proposals/2026-05-23-progress-drafts.md).
 *
 * Strategy: mock `./config.js` so each test owns the channels shape it cares
 * about, then assert the resolver normalizes shape, drops garbage, and
 * v1-forces `finalizePolicy: 'release'`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfigMock = vi.fn();
const getEffectiveStreamingOverrideMock = vi.fn();
vi.mock('./config.js', () => ({ getConfig: () => getConfigMock() }));
vi.mock('./session-overrides.js', () => ({
  getEffectiveStreamingOverride: (jid: string) => getEffectiveStreamingOverrideMock(jid),
}));

import { resolveProgressStreamingForChannel, resolveProgressStreamingForChat } from './streaming-config.js';

function withChannels(channels: Record<string, unknown>): void {
  getConfigMock.mockReturnValue({ channels });
}

describe('resolveProgressStreamingForChannel', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
  });

  it('returns mode=off when channels block is missing', () => {
    getConfigMock.mockReturnValue({});
    expect(resolveProgressStreamingForChannel('telegram')).toEqual({
      mode: 'off',
      options: {},
    });
  });

  it('returns mode=off when channel has no streaming block', () => {
    withChannels({ telegram: { enabled: true } });
    expect(resolveProgressStreamingForChannel('telegram')).toEqual({
      mode: 'off',
      options: {},
    });
  });

  it('returns mode=off + empty options when streaming.mode is unknown', () => {
    withChannels({ telegram: { enabled: true, streaming: { mode: 'bogus' } } });
    expect(resolveProgressStreamingForChannel('telegram').mode).toBe('off');
  });

  it('reads mode=progress and forces finalizePolicy=release in v1', () => {
    withChannels({
      telegram: {
        enabled: true,
        streaming: {
          mode: 'progress',
          progress: {
            label: 'Hacking…',
            maxLines: 6,
            initialDelayMs: 1500,
            detail: 'raw',
            finalizePolicy: 'edit-in-place',
          },
        },
      },
    });
    const res = resolveProgressStreamingForChannel('telegram');
    expect(res.mode).toBe('progress');
    expect(res.options).toMatchObject({
      label: 'Hacking…',
      maxLines: 6,
      initialDelayMs: 1500,
      detail: 'raw',
      // V1: edit-in-place requested in config, but resolver forces release
      // until dispatcher implements the answer-suppression handoff.
      finalizePolicy: 'release',
    });
  });

  it('accepts label:false to suppress the label line', () => {
    withChannels({
      telegram: {
        enabled: true,
        streaming: { mode: 'progress', progress: { label: false } },
      },
    });
    expect(resolveProgressStreamingForChannel('telegram').options.label).toBe(false);
  });

  it('drops invalid types (label number, labels with non-string, negative delay)', () => {
    withChannels({
      telegram: {
        enabled: true,
        streaming: {
          mode: 'progress',
          progress: {
            label: 42,
            labels: ['ok', 7],
            initialDelayMs: -1,
            maxLines: 0,
            maxLineChars: -5,
            detail: 'rainbow',
            finalizePolicy: 'whatever',
          },
        },
      },
    });
    const opts = resolveProgressStreamingForChannel('telegram').options;
    expect(opts.label).toBeUndefined();
    expect(opts.labels).toBeUndefined();
    expect(opts.initialDelayMs).toBeUndefined();
    expect(opts.maxLines).toBeUndefined();
    expect(opts.maxLineChars).toBeUndefined();
    expect(opts.detail).toBeUndefined();
    // finalizePolicy: invalid value rejected, then v1 force still kicks in.
    expect(opts.finalizePolicy).toBe('release');
  });

  it('isolates channels (teams config does not bleed into telegram lookup)', () => {
    withChannels({
      teams: { enabled: true, streaming: { mode: 'progress' } },
      telegram: { enabled: true, streaming: { mode: 'off' } },
    });
    expect(resolveProgressStreamingForChannel('teams').mode).toBe('progress');
    expect(resolveProgressStreamingForChannel('telegram').mode).toBe('off');
  });

  it('returns mode=off for unknown channel names', () => {
    withChannels({ telegram: { enabled: true, streaming: { mode: 'progress' } } });
    expect(resolveProgressStreamingForChannel('discord').mode).toBe('off');
  });
});

describe('resolveProgressStreamingForChat', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    getEffectiveStreamingOverrideMock.mockReset();
    getEffectiveStreamingOverrideMock.mockReturnValue(undefined);
  });

  it('falls through to channel config when no per-chat override', () => {
    withChannels({ telegram: { enabled: true, streaming: { mode: 'progress' } } });
    expect(resolveProgressStreamingForChat('telegram', 'group:abc').mode).toBe('progress');
  });

  it('per-chat override beats channel config', () => {
    withChannels({ telegram: { enabled: true, streaming: { mode: 'progress' } } });
    getEffectiveStreamingOverrideMock.mockReturnValue('off');
    expect(resolveProgressStreamingForChat('telegram', 'group:abc').mode).toBe('off');
  });

  it('per-chat override enables progress even when channel config is off', () => {
    withChannels({ telegram: { enabled: true, streaming: { mode: 'off' } } });
    getEffectiveStreamingOverrideMock.mockReturnValue('progress');
    const res = resolveProgressStreamingForChat('telegram', 'group:abc');
    expect(res.mode).toBe('progress');
    // options block still comes from channel config (slash only flips mode).
    expect(res.options.finalizePolicy).toBe('release');
  });

  it('preserves channel options when override flips mode', () => {
    withChannels({
      telegram: {
        enabled: true,
        streaming: {
          mode: 'off',
          progress: { label: 'Working…', maxLines: 8 },
        },
      },
    });
    getEffectiveStreamingOverrideMock.mockReturnValue('progress');
    const res = resolveProgressStreamingForChat('telegram', 'group:abc');
    expect(res.mode).toBe('progress');
    expect(res.options.label).toBe('Working…');
    expect(res.options.maxLines).toBe(8);
  });
});
