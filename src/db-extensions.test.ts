import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  aggregateUsage,
  appendUsageEvent,
  getQuotaSnapshot,
  getQuotaSnapshots,
  getUsageLog,
  isUsageTrackingEnabled,
  upsertQuotaSnapshot,
  vacuumUsageLog,
  type QuotaSnapshot,
  type UsageEvent,
} from './db-extensions.js';

beforeEach(() => {
  _initTestDatabase();
});

const ghcEvent = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  groupFolder: 'main',
  sessionId: 'sess-abc',
  runner: 'ghc',
  model: 'claude-opus-4.7',
  inputTokens: 1000,
  outputTokens: 250,
  cacheRead: 800,
  cacheWrite: 100,
  reasoningTokens: 50,
  costUsd: 0.04,
  durationMs: 1200,
  ttftMs: 38,
  rawJson: '{"copilotUsage":{"totalNanoAiu":42}}',
  ...over,
});

const ccEvent = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  groupFolder: 'main',
  runner: 'cc',
  model: 'claude-sonnet-4.5',
  inputTokens: 500,
  outputTokens: 200,
  cacheRead: 400,
  cacheWrite: 50,
  // CC: no cost, no ttft
  ...over,
});

describe('usage_log: appendUsageEvent() + getUsageLog()', () => {
  it('writes a row and returns its id', () => {
    const id = appendUsageEvent(ghcEvent());
    expect(id).toBeGreaterThan(0);
    const rows = getUsageLog();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe(id);
    expect(r.runner).toBe('ghc');
    expect(r.model).toBe('claude-opus-4.7');
    expect(r.inputTokens).toBe(1000);
    expect(r.cacheRead).toBe(800);
    expect(r.reasoningTokens).toBe(50);
    expect(r.costUsd).toBeCloseTo(0.04);
    expect(r.ttftMs).toBe(38);
    expect(r.rawJson).toContain('totalNanoAiu');
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('supports CC events with NULL cost / ttft', () => {
    appendUsageEvent(ccEvent());
    const r = getUsageLog()[0];
    expect(r.runner).toBe('cc');
    expect(r.costUsd).toBeNull();
    expect(r.ttftMs).toBeNull();
    expect(r.inputTokens).toBe(500);
  });

  it('orders rows DESC by ts then id (newest first)', () => {
    appendUsageEvent(
      ghcEvent({ ts: '2026-04-19T10:00:00.000Z', inputTokens: 100 }),
    );
    appendUsageEvent(
      ghcEvent({ ts: '2026-04-19T11:00:00.000Z', inputTokens: 200 }),
    );
    appendUsageEvent(
      ghcEvent({ ts: '2026-04-19T11:00:00.000Z', inputTokens: 300 }),
    );
    const rows = getUsageLog();
    expect(rows.map((r) => r.inputTokens)).toEqual([300, 200, 100]);
  });

  it('filters by groupFolder + sinceIso + limit', () => {
    appendUsageEvent(
      ghcEvent({ groupFolder: 'main', ts: '2026-04-18T00:00:00.000Z' }),
    );
    appendUsageEvent(
      ghcEvent({ groupFolder: 'main', ts: '2026-04-19T00:00:00.000Z' }),
    );
    appendUsageEvent(
      ghcEvent({ groupFolder: 'tg-12', ts: '2026-04-19T01:00:00.000Z' }),
    );
    appendUsageEvent(
      ghcEvent({ groupFolder: 'main', ts: '2026-04-19T02:00:00.000Z' }),
    );

    const mainSince19 = getUsageLog({
      groupFolder: 'main',
      sinceIso: '2026-04-19T00:00:00.000Z',
    });
    expect(mainSince19).toHaveLength(2);
    expect(mainSince19.every((r) => r.groupFolder === 'main')).toBe(true);

    const limited = getUsageLog({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

describe('usage_log: aggregateUsage()', () => {
  it('returns zeros on empty table', () => {
    const a = aggregateUsage();
    expect(a).toEqual({
      rowCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  it('sums across rows and excludes NULL cost rows from cost sum', () => {
    appendUsageEvent(ghcEvent({ inputTokens: 1000, costUsd: 0.04 }));
    appendUsageEvent(ghcEvent({ inputTokens: 500, costUsd: 0.02 }));
    appendUsageEvent(ccEvent({ inputTokens: 300 })); // cost NULL
    const a = aggregateUsage();
    expect(a.rowCount).toBe(3);
    expect(a.inputTokens).toBe(1800);
    expect(a.costUsd).toBeCloseTo(0.06);
  });

  it('respects groupFolder + sinceIso filters', () => {
    appendUsageEvent(
      ghcEvent({
        groupFolder: 'a',
        ts: '2026-04-18T00:00:00.000Z',
        inputTokens: 100,
      }),
    );
    appendUsageEvent(
      ghcEvent({
        groupFolder: 'a',
        ts: '2026-04-19T00:00:00.000Z',
        inputTokens: 200,
      }),
    );
    appendUsageEvent(
      ghcEvent({
        groupFolder: 'b',
        ts: '2026-04-19T00:00:00.000Z',
        inputTokens: 999,
      }),
    );
    const a = aggregateUsage({
      groupFolder: 'a',
      sinceIso: '2026-04-19T00:00:00.000Z',
    });
    expect(a.rowCount).toBe(1);
    expect(a.inputTokens).toBe(200);
  });
});

describe('usage_log: vacuumUsageLog()', () => {
  it('deletes rows strictly older than cutoff and returns count', () => {
    appendUsageEvent(ghcEvent({ ts: '2026-01-01T00:00:00.000Z' }));
    appendUsageEvent(ghcEvent({ ts: '2026-04-18T00:00:00.000Z' }));
    appendUsageEvent(ghcEvent({ ts: '2026-04-19T00:00:00.000Z' }));
    const removed = vacuumUsageLog('2026-04-19T00:00:00.000Z');
    expect(removed).toBe(2);
    const remaining = getUsageLog();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ts).toBe('2026-04-19T00:00:00.000Z');
  });
});

describe('quota_snapshots: upsert + read', () => {
  it('inserts a fresh snapshot then upserts on (runner, model) conflict', () => {
    upsertQuotaSnapshot({
      runner: 'ghc',
      model: 'claude-opus-4.7',
      pctRemaining: 89,
      usedRequests: 55,
      entitlementRequests: 500,
      resetDate: '2026-04-30',
      ts: '2026-04-19T10:00:00.000Z',
    });
    const a = getQuotaSnapshot('ghc', 'claude-opus-4.7');
    expect(a?.pctRemaining).toBe(89);
    expect(a?.usedRequests).toBe(55);
    expect(a?.isUnlimited).toBe(false);

    upsertQuotaSnapshot({
      runner: 'ghc',
      model: 'claude-opus-4.7',
      pctRemaining: 73,
      usedRequests: 135,
      ts: '2026-04-19T11:00:00.000Z',
    });
    const b = getQuotaSnapshot('ghc', 'claude-opus-4.7');
    expect(b?.pctRemaining).toBe(73);
    expect(b?.usedRequests).toBe(135);
    expect(b?.ts).toBe('2026-04-19T11:00:00.000Z');
    expect(getQuotaSnapshots()).toHaveLength(1);
  });

  it('separates rows per (runner, model) tuple', () => {
    const snap = (over: Partial<QuotaSnapshot>): QuotaSnapshot => ({
      runner: 'ghc',
      model: 'claude-opus-4.7',
      pctRemaining: 80,
      ...over,
    });
    upsertQuotaSnapshot(snap({}));
    upsertQuotaSnapshot(snap({ model: 'claude-sonnet-4.5' }));
    upsertQuotaSnapshot(
      snap({ runner: 'cc', model: 'claude-sonnet-4.5', isUnlimited: true }),
    );
    const all = getQuotaSnapshots();
    expect(all).toHaveLength(3);
    const cc = all.find((s) => s.runner === 'cc');
    expect(cc?.isUnlimited).toBe(true);
  });
});

describe('isUsageTrackingEnabled()', () => {
  const original = process.env.NANOCLAW_USAGE_TRACKING;
  afterEach(() => {
    if (original === undefined) delete process.env.NANOCLAW_USAGE_TRACKING;
    else process.env.NANOCLAW_USAGE_TRACKING = original;
  });

  it('defaults OFF when env is absent', () => {
    delete process.env.NANOCLAW_USAGE_TRACKING;
    expect(isUsageTrackingEnabled()).toBe(false);
  });

  it('accepts "1" and "true" (case-insensitive)', () => {
    process.env.NANOCLAW_USAGE_TRACKING = '1';
    expect(isUsageTrackingEnabled()).toBe(true);
    process.env.NANOCLAW_USAGE_TRACKING = 'TRUE';
    expect(isUsageTrackingEnabled()).toBe(true);
    process.env.NANOCLAW_USAGE_TRACKING = 'true';
    expect(isUsageTrackingEnabled()).toBe(true);
  });

  it('rejects other truthy-looking values', () => {
    process.env.NANOCLAW_USAGE_TRACKING = 'yes';
    expect(isUsageTrackingEnabled()).toBe(false);
    process.env.NANOCLAW_USAGE_TRACKING = '0';
    expect(isUsageTrackingEnabled()).toBe(false);
    process.env.NANOCLAW_USAGE_TRACKING = '';
    expect(isUsageTrackingEnabled()).toBe(false);
  });
});
