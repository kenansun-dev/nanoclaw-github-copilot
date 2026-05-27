import { describe, test, expect } from 'vitest';
import {
  createProgressDraftSession,
  renderProgressLine,
  resolveProgressToolSpec,
  type ProgressEvent,
  type ProgressTransport,
} from './progress-draft.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fake scheduler: collects pending timers and runs them on demand. */
function makeFakeScheduler() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    scheduler: {
      setTimeout(cb: () => void, _ms: number): number {
        const id = next++;
        timers.set(id, cb);
        return id;
      },
      clearTimeout(h: unknown): void {
        if (typeof h === 'number') timers.delete(h);
      },
    },
    runAll(): void {
      for (const cb of [...timers.values()]) cb();
      timers.clear();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** Fake transport: records every send/edit; supplies a stable msgId. */
function makeRecordingTransport(msgId: string = 'm1'): {
  transport: ProgressTransport;
  sent: string[];
  edited: string[];
} {
  const sent: string[] = [];
  const edited: string[] = [];
  const transport: ProgressTransport = {
    async sendDraft(text: string) {
      sent.push(text);
      return msgId;
    },
    async editDraft(id: string, text: string) {
      expect(id).toBe(msgId);
      edited.push(text);
    },
  };
  return { transport, sent, edited };
}

const startEvt = (id: string, name: string, args?: Record<string, unknown>): ProgressEvent => ({
  kind: 'tool_start',
  toolCallId: id,
  toolName: name,
  ...(args ? { arguments: args } : {}),
});
const progressEvt = (id: string, message: string): ProgressEvent => ({
  kind: 'tool_progress',
  toolCallId: id,
  message,
});
const doneEvt = (id: string, success: boolean, error?: string): ProgressEvent => ({
  kind: 'tool_done',
  toolCallId: id,
  success,
  ...(error ? { error } : {}),
});

const flush = () => new Promise((r) => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// resolveProgressToolSpec
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveProgressToolSpec', () => {
  test('returns spec for known tool name', () => {
    const spec = resolveProgressToolSpec('bash');
    expect(spec.emoji).toBe('🛠️');
    expect(spec.title).toBe('Bash');
    expect(spec.detailKeys).toContain('command');
  });

  test('is case-insensitive', () => {
    expect(resolveProgressToolSpec('BASH').title).toBe('Bash');
  });

  test('strips MCP server prefix (underscore separator)', () => {
    const spec = resolveProgressToolSpec('nanoclaw_send_message');
    expect(spec.emoji).toBe('💬');
    expect(spec.title).toBe('Send');
  });

  test('strips MCP server prefix (dot separator)', () => {
    const spec = resolveProgressToolSpec('github.web_search');
    expect(spec.emoji).toBe('🌐');
    expect(spec.title).toBe('Search');
  });

  test('falls back to title-cased name on unknown', () => {
    const spec = resolveProgressToolSpec('totally_made_up');
    expect(spec.emoji).toBe('🧩');
    expect(spec.title).toBe('Totally Made Up');
  });

  test('handles empty / undefined', () => {
    expect(resolveProgressToolSpec(undefined).title).toBe('Tool');
    expect(resolveProgressToolSpec('').title).toBe('Tool');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderProgressLine
// ─────────────────────────────────────────────────────────────────────────────

describe('renderProgressLine', () => {
  const baseLine = {
    toolCallId: 'c1',
    toolName: 'bash',
    emoji: '🛠️',
    title: 'Bash',
    seq: 0,
  };

  test('explain mode: emoji + title only', () => {
    expect(renderProgressLine({ ...baseLine, detail: 'npm test' }, 'explain', 120)).toBe('🛠️ Bash');
  });

  test('raw mode: appends detail', () => {
    expect(renderProgressLine({ ...baseLine, detail: 'npm test' }, 'raw', 120)).toBe('🛠️ Bash: npm test');
  });

  test('progress message wins over arg detail in raw mode', () => {
    expect(renderProgressLine({ ...baseLine, detail: 'npm test', progressMessage: 'fetched 12/40' }, 'raw', 120)).toBe(
      '🛠️ Bash: fetched 12/40',
    );
  });

  test('progress message shows even in explain mode', () => {
    expect(renderProgressLine({ ...baseLine, progressMessage: 'fetched 12/40' }, 'explain', 120)).toBe(
      '🛠️ Bash: fetched 12/40',
    );
  });

  test('success ✓ suffix on done', () => {
    expect(renderProgressLine({ ...baseLine, success: true }, 'explain', 120)).toBe('🛠️ Bash ✓');
  });

  test('failure ✗ + error summary', () => {
    expect(renderProgressLine({ ...baseLine, success: false, errorSummary: 'exit 1' }, 'explain', 120)).toBe(
      '🛠️ Bash ✗ exit 1',
    );
  });

  test('truncates to maxLineChars with ellipsis', () => {
    const out = renderProgressLine({ ...baseLine, detail: 'a'.repeat(200) }, 'raw', 30);
    expect(out.length).toBe(30);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Open gate
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — open gate', () => {
  test('does NOT open when finalize happens before delay AND only one tool ran', async () => {
    const fake = makeFakeScheduler();
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      scheduler: fake.scheduler,
      options: { initialDelayMs: 5000, label: false },
    });
    sess.apply(startEvt('c1', 'bash', { command: 'ls' }));
    sess.apply(doneEvt('c1', true));
    expect(sess.isOpen()).toBe(false);
    await sess.finalize('the answer');
    expect(sess.isOpen()).toBe(false);
    expect(t.sent).toEqual([]);
    expect(t.edited).toEqual([]);
  });

  test('opens draft after initialDelayMs even with one tool', async () => {
    const fake = makeFakeScheduler();
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      scheduler: fake.scheduler,
      options: { initialDelayMs: 5000, label: false },
    });
    sess.apply(startEvt('c1', 'bash', { command: 'npm test' }));
    expect(fake.pendingCount()).toBe(1);
    fake.runAll();
    await flush();
    expect(t.sent.length).toBe(1);
    expect(t.sent[0]).toContain('🛠️ Bash');
    expect(sess.isOpen()).toBe(true);
  });

  test('opens immediately on 2nd tool_start (work-event override)', async () => {
    const fake = makeFakeScheduler();
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      scheduler: fake.scheduler,
      options: { initialDelayMs: 60000, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    expect(fake.pendingCount()).toBe(1);
    expect(sess.isOpen()).toBe(false);
    sess.apply(startEvt('c2', 'read', { path: '/etc/hosts' }));
    expect(fake.pendingCount()).toBe(0);
    await flush();
    expect(t.sent.length).toBe(1);
    expect(t.sent[0]).toContain('🛠️ Bash');
    expect(t.sent[0]).toContain('📖 Read');
  });

  test('initialDelayMs=0 opens on first tool_start', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash', { command: 'whoami' }));
    await flush();
    expect(t.sent.length).toBe(1);
    expect(sess.isOpen()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Line lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — line lifecycle', () => {
  test('start → progress → done updates the bubble', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'web_fetch', { url: 'https://example.com' }));
    await flush();
    expect(t.sent[0]).toContain('🌐 Fetch');

    sess.apply(progressEvt('c1', 'received 12 KB'));
    await flush();
    expect(t.edited.at(-1)).toContain('received 12 KB');

    sess.apply(doneEvt('c1', true));
    await flush();
    expect(t.edited.at(-1)).toContain('🌐 Fetch ✓');
    expect(t.edited.at(-1)).not.toContain('received');
  });

  test('error on done renders ✗ + summary', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(doneEvt('c1', false, 'command not found: foo'));
    await flush();
    const latest = t.edited.at(-1) ?? t.sent.at(-1)!;
    expect(latest).toContain('✗');
    expect(latest).toContain('command not found');
  });

  test('dedupes duplicate tool_start with same toolCallId', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(startEvt('c1', 'bash')); // dup
    sess.apply(startEvt('c2', 'read', { path: '/x' }));
    await flush();
    const latest = t.edited.at(-1) ?? t.sent.at(-1)!;
    const lines = latest.split('\n').filter((l) => l.includes('🛠️') || l.includes('📖'));
    expect(lines.length).toBe(2);
  });

  test('progress/done for unknown toolCallId is a no-op', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(progressEvt('ghost', 'orphan progress'));
    sess.apply(doneEvt('ghost', true));
    await flush();
    expect(t.sent).toEqual([]);
    expect(t.edited).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rolling window
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — rolling window', () => {
  test('drops oldest DONE line when over maxLines; keeps in-flight', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false, maxLines: 2 },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(doneEvt('c1', true));
    sess.apply(startEvt('c2', 'read', { path: '/a' }));
    sess.apply(doneEvt('c2', true));
    sess.apply(startEvt('c3', 'web_fetch', { url: 'https://x' }));
    await flush();
    const latest = t.edited.at(-1) ?? t.sent.at(-1)!;
    // c1 (oldest done) evicted; c2 + c3 remain.
    expect(latest).not.toMatch(/🛠️ Bash/);
    expect(latest).toContain('📖 Read');
    expect(latest).toContain('🌐 Fetch');
  });

  test('never drops in-flight even when over budget', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false, maxLines: 1 },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(startEvt('c2', 'read'));
    sess.apply(startEvt('c3', 'web_fetch'));
    await flush();
    const latest = t.edited.at(-1) ?? t.sent.at(-1)!;
    expect(latest).toContain('🛠️ Bash');
    expect(latest).toContain('📖 Read');
    expect(latest).toContain('🌐 Fetch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finalize
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — finalize', () => {
  test('edit-in-place: final edit equals the answer text', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false, finalizePolicy: 'edit-in-place' },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(doneEvt('c1', true));
    await flush();
    const msgId = await sess.finalize('Hello, world.');
    expect(msgId).toBe('m1');
    expect(t.edited.at(-1)).toBe('Hello, world.');
  });

  test('release: final edit is summary, not answer text', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false, finalizePolicy: 'release' },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(doneEvt('c1', true));
    sess.apply(startEvt('c2', 'read'));
    sess.apply(doneEvt('c2', false, 'enoent'));
    await flush();
    const msgId = await sess.finalize('Hello, world.');
    expect(msgId).toBe('m1');
    expect(t.edited.at(-1)).not.toContain('Hello, world.');
    expect(t.edited.at(-1)).toContain('✅ 1 done');
    expect(t.edited.at(-1)).toContain('❌ 1 failed');
  });

  test('finalize on never-opened session returns undefined and does not touch the wire', async () => {
    const fake = makeFakeScheduler();
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      scheduler: fake.scheduler,
      options: { initialDelayMs: 5000, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    expect(fake.pendingCount()).toBe(1);
    const msgId = await sess.finalize('the answer');
    expect(msgId).toBeUndefined();
    expect(t.sent).toEqual([]);
    expect(fake.pendingCount()).toBe(0);
  });

  test('subsequent applies after finalize are ignored', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    await sess.finalize('done');
    const beforeCount = t.edited.length;
    sess.apply(startEvt('c2', 'read'));
    sess.apply(doneEvt('c2', true));
    await flush();
    expect(t.edited.length).toBe(beforeCount);
  });

  test('abandon clears timers and suppresses further wire traffic', async () => {
    const fake = makeFakeScheduler();
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      scheduler: fake.scheduler,
      options: { initialDelayMs: 5000, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.abandon();
    expect(fake.pendingCount()).toBe(0);
    fake.runAll(); // no-op
    await flush();
    expect(t.sent).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire dedupe
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — wire dedupe', () => {
  test('does not edit when re-applied event produces identical text', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    const sentInitial = t.sent.length;
    const editsInitial = t.edited.length;
    sess.apply(progressEvt('c1', 'step 1/3'));
    await flush();
    sess.apply(progressEvt('c1', 'step 1/3'));
    await flush();
    expect(t.sent.length).toBe(sentInitial);
    expect(t.edited.length).toBe(editsInitial + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — error handling', () => {
  test('transport sendDraft throw → onError fired, no draft open', async () => {
    const errs: { stage: string; msg: string }[] = [];
    const transport: ProgressTransport = {
      async sendDraft() {
        throw new Error('429 too many requests');
      },
      async editDraft() {
        /* should never be called */
      },
    };
    const sess = createProgressDraftSession({
      transport,
      options: { initialDelayMs: 0, label: false },
      onError: (err, ctx) => errs.push({ stage: ctx.stage, msg: err.message }),
    });
    sess.apply(startEvt('c1', 'bash'));
    sess.apply(doneEvt('c1', true));
    await flush();
    const msgId = await sess.finalize('the answer');
    expect(msgId).toBeUndefined();
    expect(errs.find((e) => e.stage === 'open')).toBeTruthy();
  });

  test('transport editDraft throw → onError, session continues to accept events', async () => {
    const errs: string[] = [];
    let editCalls = 0;
    const transport: ProgressTransport = {
      async sendDraft() {
        return 'm1';
      },
      async editDraft() {
        editCalls++;
        if (editCalls === 1) throw new Error('rate limited');
      },
    };
    const sess = createProgressDraftSession({
      transport,
      options: { initialDelayMs: 0, label: false },
      onError: (err, ctx) => errs.push(`${ctx.stage}: ${err.message}`),
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    sess.apply(progressEvt('c1', 'step 1/3'));
    await flush();
    sess.apply(doneEvt('c1', true));
    await flush();
    expect(errs.length).toBeGreaterThan(0);
    expect(editCalls).toBeGreaterThan(1); // session kept going after the throw
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Label
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressDraftSession — label', () => {
  test('explicit label string is used verbatim', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: 'Working on it…' },
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    expect(t.sent[0]).toMatch(/^Working on it…/);
  });

  test('label: false renders no label header', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: false },
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    expect(t.sent[0]).toMatch(/^🛠️ Bash/);
  });

  test('label: "auto" picks from labels pool deterministically when rng is fixed', async () => {
    const t = makeRecordingTransport();
    const sess = createProgressDraftSession({
      transport: t.transport,
      options: { initialDelayMs: 0, label: 'auto', labels: ['Alpha', 'Beta', 'Gamma'] },
      rng: () => 0.5,
    });
    sess.apply(startEvt('c1', 'bash'));
    await flush();
    expect(t.sent[0]).toMatch(/^Beta/);
  });
});
