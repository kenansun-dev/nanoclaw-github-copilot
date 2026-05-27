/**
 * Pure GHC SDK event → progress envelope mapping.
 *
 * Extracted from index.ts so unit tests can import without booting
 * the full runner (which calls `main()` on import). Same pattern used
 * for ipc-helpers.ts (see ipc-helpers.test.ts history note about
 * fake-coverage before the extraction).
 *
 * IMPORTANT: keep the ContainerProgressEnvelope shape byte-equivalent
 * to src/container-runner.ts ContainerProgressEnvelope — the host
 * dispatcher / ProgressDraftSession (src/progress-draft.ts) consume
 * these verbatim.
 */

export type ContainerProgressEnvelope =
  | {
      kind: 'tool_start';
      toolCallId: string;
      toolName: string;
      /** Set when the tool is an MCP tool (`mcpServerName.toolName`). */
      mcpServerName?: string;
      /** Original tool name on the MCP server, when applicable. */
      mcpToolName?: string;
      /** Tool input arguments, when surfaced by the SDK. */
      arguments?: Record<string, unknown>;
      /** True when the SDK delivered this via `tool.user_requested`. */
      userInitiated?: boolean;
    }
  | {
      kind: 'tool_progress';
      toolCallId: string;
      /** Human-readable status; either MCP `progressMessage` or a runner
       * preview of `partialOutput`. */
      message: string;
    }
  | {
      kind: 'tool_done';
      toolCallId: string;
      success: boolean;
      /** Short error string when success=false (from SDK `error.message`). */
      error?: string;
    };

/**
 * Maximum preview length for a `tool.execution_partial_result` payload
 * before we forward it as a tool_progress envelope. Keep this tight
 * (one line, ~120 chars) so the host's progress draft stays scannable;
 * the host already does its own per-line truncation but we don't want
 * to ship multi-line shell output across the IPC boundary just for it
 * to be lopped off.
 */
export const PARTIAL_PROGRESS_PREVIEW_MAX = 120;

export function summarizePartialOutput(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > PARTIAL_PROGRESS_PREVIEW_MAX
    ? trimmed.slice(0, PARTIAL_PROGRESS_PREVIEW_MAX - 1) + '\u2026'
    : trimmed;
}

/**
 * Translate a GHC SDK session event into a ContainerProgressEnvelope
 * suitable for the host's progress-draft lane. Returns undefined for
 * unrelated events (or malformed payloads) so the caller can ignore
 * them silently.
 *
 * Mapping (matches src/container-runner.ts ContainerProgressEnvelope):
 *   tool.execution_start          → tool_start
 *   tool.user_requested           → tool_start (userInitiated=true)
 *   tool.execution_progress       → tool_progress (MCP progressMessage)
 *   tool.execution_partial_result → tool_progress (preview of stdout)
 *   tool.execution_complete       → tool_done (success + error.message)
 *
 * Guards: drops events with missing toolCallId / toolName / success
 * because the host can't render a line without those. Drops empty
 * partial_result chunks (the SDK occasionally emits whitespace-only
 * deltas while a long-running command initializes). Never throws.
 */
export function toProgressEnvelope(event: unknown): ContainerProgressEnvelope | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as { type?: unknown; data?: unknown };
  const type = e.type;
  if (!e.data || typeof e.data !== 'object') return undefined;
  const data = e.data as Record<string, unknown>;
  const toolCallId = data.toolCallId;
  if (typeof toolCallId !== 'string' || !toolCallId) return undefined;

  switch (type) {
    case 'tool.execution_start': {
      if (typeof data.toolName !== 'string') return undefined;
      const env: ContainerProgressEnvelope = {
        kind: 'tool_start',
        toolCallId,
        toolName: data.toolName,
      };
      if (typeof data.mcpServerName === 'string') env.mcpServerName = data.mcpServerName;
      if (typeof data.mcpToolName === 'string') env.mcpToolName = data.mcpToolName;
      if (data.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments)) {
        env.arguments = data.arguments as Record<string, unknown>;
      }
      return env;
    }
    case 'tool.user_requested': {
      if (typeof data.toolName !== 'string') return undefined;
      const env: ContainerProgressEnvelope = {
        kind: 'tool_start',
        toolCallId,
        toolName: data.toolName,
        userInitiated: true,
      };
      if (data.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments)) {
        env.arguments = data.arguments as Record<string, unknown>;
      }
      return env;
    }
    case 'tool.execution_progress': {
      if (typeof data.progressMessage !== 'string' || !data.progressMessage) return undefined;
      return { kind: 'tool_progress', toolCallId, message: data.progressMessage };
    }
    case 'tool.execution_partial_result': {
      const preview = summarizePartialOutput(data.partialOutput);
      if (!preview) return undefined;
      return { kind: 'tool_progress', toolCallId, message: preview };
    }
    case 'tool.execution_complete': {
      if (typeof data.success !== 'boolean') return undefined;
      const env: ContainerProgressEnvelope = {
        kind: 'tool_done',
        toolCallId,
        success: data.success,
      };
      // SDK `data.error.message` only carries on failures (success=false);
      // include it when present so the host can render a short reason.
      const errBlock = data.error as { message?: unknown } | undefined;
      const errMsg = errBlock && typeof errBlock.message === 'string' ? errBlock.message : undefined;
      if (errMsg && !data.success) env.error = errMsg;
      return env;
    }
    default:
      return undefined;
  }
}
