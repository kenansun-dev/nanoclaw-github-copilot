import { describe, test, expect } from 'vitest';
import {
  toProgressEnvelope,
  summarizePartialOutput,
  PARTIAL_PROGRESS_PREVIEW_MAX,
} from './progress-envelope.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const mkEvent = (type: string, data: Record<string, unknown>) => ({
  id: 'evt-1',
  timestamp: '2026-05-24T02:00:00Z',
  parentId: null,
  type,
  data,
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizePartialOutput
// ─────────────────────────────────────────────────────────────────────────────

describe('summarizePartialOutput', () => {
  test('returns undefined for non-string', () => {
    expect(summarizePartialOutput(undefined)).toBeUndefined();
    expect(summarizePartialOutput(null)).toBeUndefined();
    expect(summarizePartialOutput(123)).toBeUndefined();
    expect(summarizePartialOutput({})).toBeUndefined();
  });

  test('returns undefined for empty / whitespace', () => {
    expect(summarizePartialOutput('')).toBeUndefined();
    expect(summarizePartialOutput('   \n\t  ')).toBeUndefined();
  });

  test('collapses internal whitespace and trims', () => {
    expect(summarizePartialOutput('hello\n\n  world\t!')).toBe('hello world !');
  });

  test('returns as-is when within limit', () => {
    const s = 'short message';
    expect(summarizePartialOutput(s)).toBe(s);
  });

  test('truncates with ellipsis when over limit', () => {
    const s = 'a'.repeat(PARTIAL_PROGRESS_PREVIEW_MAX + 50);
    const out = summarizePartialOutput(s)!;
    expect(out.length).toBe(PARTIAL_PROGRESS_PREVIEW_MAX);
    expect(out.endsWith('\u2026')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toProgressEnvelope — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('toProgressEnvelope — tool.execution_start', () => {
  test('maps minimal start event', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_start', { toolCallId: 'c1', toolName: 'bash' }),
    );
    expect(env).toEqual({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash' });
  });

  test('includes MCP server + tool name + arguments when present', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_start', {
        toolCallId: 'c2',
        toolName: 'nanoclaw_send_message',
        mcpServerName: 'nanoclaw',
        mcpToolName: 'send_message',
        arguments: { to: 'kenan', text: 'hi' },
      }),
    );
    expect(env).toEqual({
      kind: 'tool_start',
      toolCallId: 'c2',
      toolName: 'nanoclaw_send_message',
      mcpServerName: 'nanoclaw',
      mcpToolName: 'send_message',
      arguments: { to: 'kenan', text: 'hi' },
    });
  });

  test('does NOT set userInitiated for normal start events', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_start', { toolCallId: 'c1', toolName: 'bash' }),
    );
    expect(env).not.toHaveProperty('userInitiated');
  });

  test('rejects start event with non-string toolName', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_start', { toolCallId: 'c1', toolName: 42 }),
      ),
    ).toBeUndefined();
  });

  test('drops array-shaped arguments (defensive)', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_start', {
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: ['not', 'an', 'object'],
      }),
    );
    expect(env).toEqual({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash' });
  });
});

describe('toProgressEnvelope — tool.user_requested', () => {
  test('maps to tool_start with userInitiated=true', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.user_requested', {
        toolCallId: 'u1',
        toolName: 'web_search',
        arguments: { query: 'rust async' },
      }),
    );
    expect(env).toEqual({
      kind: 'tool_start',
      toolCallId: 'u1',
      toolName: 'web_search',
      userInitiated: true,
      arguments: { query: 'rust async' },
    });
  });

  test('rejects without toolName', () => {
    expect(
      toProgressEnvelope(mkEvent('tool.user_requested', { toolCallId: 'u1' })),
    ).toBeUndefined();
  });
});

describe('toProgressEnvelope — tool.execution_progress', () => {
  test('maps MCP progressMessage to tool_progress', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_progress', {
        toolCallId: 'c1',
        progressMessage: 'fetched 12/40',
      }),
    );
    expect(env).toEqual({
      kind: 'tool_progress',
      toolCallId: 'c1',
      message: 'fetched 12/40',
    });
  });

  test('drops events with empty progressMessage', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_progress', { toolCallId: 'c1', progressMessage: '' }),
      ),
    ).toBeUndefined();
  });

  test('drops events with non-string progressMessage', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_progress', { toolCallId: 'c1', progressMessage: 123 }),
      ),
    ).toBeUndefined();
  });
});

describe('toProgressEnvelope — tool.execution_partial_result', () => {
  test('previews short stdout', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_partial_result', {
        toolCallId: 'c1',
        partialOutput: 'compiling foo.rs',
      }),
    );
    expect(env).toEqual({
      kind: 'tool_progress',
      toolCallId: 'c1',
      message: 'compiling foo.rs',
    });
  });

  test('truncates long stdout with ellipsis', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_partial_result', {
        toolCallId: 'c1',
        partialOutput: 'x'.repeat(500),
      }),
    );
    expect(env?.kind).toBe('tool_progress');
    if (env?.kind === 'tool_progress') {
      expect(env.message.length).toBe(PARTIAL_PROGRESS_PREVIEW_MAX);
      expect(env.message.endsWith('\u2026')).toBe(true);
    }
  });

  test('drops whitespace-only partial chunks', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_partial_result', {
          toolCallId: 'c1',
          partialOutput: '   \n\n   ',
        }),
      ),
    ).toBeUndefined();
  });

  test('drops empty partialOutput', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_partial_result', { toolCallId: 'c1', partialOutput: '' }),
      ),
    ).toBeUndefined();
  });
});

describe('toProgressEnvelope — tool.execution_complete', () => {
  test('maps success', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_complete', { toolCallId: 'c1', success: true }),
    );
    expect(env).toEqual({ kind: 'tool_done', toolCallId: 'c1', success: true });
  });

  test('maps failure with SDK error.message', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_complete', {
        toolCallId: 'c1',
        success: false,
        error: { message: 'command not found', code: 'ENOENT' },
      }),
    );
    expect(env).toEqual({
      kind: 'tool_done',
      toolCallId: 'c1',
      success: false,
      error: 'command not found',
    });
  });

  test('does not attach error on successful complete (even if error block present)', () => {
    // SDK may emit a benign warning-shaped error block on success; we treat
    // success=true as authoritative and drop the error field to avoid
    // misleading "✗" rendering host-side.
    const env = toProgressEnvelope(
      mkEvent('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        error: { message: 'warning: deprecated' },
      }),
    );
    expect(env).toEqual({ kind: 'tool_done', toolCallId: 'c1', success: true });
  });

  test('drops complete with non-boolean success', () => {
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_complete', { toolCallId: 'c1', success: 'yes' }),
      ),
    ).toBeUndefined();
  });

  test('omits error when SDK error.message is missing', () => {
    const env = toProgressEnvelope(
      mkEvent('tool.execution_complete', {
        toolCallId: 'c1',
        success: false,
        error: { code: 'EFAIL' },
      }),
    );
    expect(env).toEqual({ kind: 'tool_done', toolCallId: 'c1', success: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toProgressEnvelope — defensive guards
// ─────────────────────────────────────────────────────────────────────────────

describe('toProgressEnvelope — guards', () => {
  test('returns undefined for null / undefined / non-object', () => {
    expect(toProgressEnvelope(null)).toBeUndefined();
    expect(toProgressEnvelope(undefined)).toBeUndefined();
    expect(toProgressEnvelope('string')).toBeUndefined();
    expect(toProgressEnvelope(42)).toBeUndefined();
  });

  test('returns undefined for unrelated event types', () => {
    expect(
      toProgressEnvelope(mkEvent('assistant.message_delta', { toolCallId: 'c1' })),
    ).toBeUndefined();
    expect(
      toProgressEnvelope(mkEvent('mcp.oauth_required', { toolCallId: 'c1' })),
    ).toBeUndefined();
    expect(
      toProgressEnvelope(mkEvent('session.warning', { toolCallId: 'c1' })),
    ).toBeUndefined();
  });

  test('returns undefined when data is missing or non-object', () => {
    expect(toProgressEnvelope({ type: 'tool.execution_start' })).toBeUndefined();
    expect(
      toProgressEnvelope({ type: 'tool.execution_start', data: null }),
    ).toBeUndefined();
    expect(
      toProgressEnvelope({ type: 'tool.execution_start', data: 'oops' }),
    ).toBeUndefined();
  });

  test('returns undefined when toolCallId is missing or non-string', () => {
    expect(
      toProgressEnvelope(mkEvent('tool.execution_start', { toolName: 'bash' })),
    ).toBeUndefined();
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_start', { toolCallId: 42, toolName: 'bash' }),
      ),
    ).toBeUndefined();
    expect(
      toProgressEnvelope(
        mkEvent('tool.execution_start', { toolCallId: '', toolName: 'bash' }),
      ),
    ).toBeUndefined();
  });
});
