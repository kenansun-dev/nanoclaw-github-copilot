/**
 * GitHub Copilot provider for v2 agent-runner.
 *
 * Wraps `@github/copilot-sdk` (CopilotClient) into the v2 AgentProvider
 * interface so the v2 poll-loop can drive GHC sessions the same way it
 * drives Claude SDK sessions.
 *
 * STATUS: C-step1 scaffold (incomplete). Implements interface shape +
 * registration so v2 can load the provider; SDK glue is stubbed.
 *
 * Phase plan:
 *   C-step1 (this file): provider interface adapt — Node runtime preserved,
 *                        IO protocol unchanged (still expects host-side
 *                        message DB writes via v2 poll-loop integration).
 *   C-step2 (next):       port the GHC `query loop + session.stream events
 *                        + IPC drain` from container/agent-runner-ghc/src/
 *                        index.ts into this provider's query()/events flow.
 *
 * Reference implementations:
 *   - container/agent-runner/src/providers/claude.ts (v2 AgentProvider impl
 *     using @anthropic-ai/claude-agent-sdk — the structural template)
 *   - container/agent-runner-ghc/src/index.ts (existing fork GHC runner —
 *     source of truth for SDK call patterns: CopilotClient, createSession /
 *     resumeSession, session.send, session.on('session.idle'/'message.delta'),
 *     approveAll permission policy, layer-1/layer-2 session recovery)
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[copilot-provider] ${msg}`);
}

class CopilotAgentProvider implements AgentProvider {
  /**
   * GHC SDK does not expose slash-command parsing; v2 poll-loop should
   * format slash commands as plain chat messages (same as Claude provider).
   */
  readonly supportsNativeSlashCommands = false;

  constructor(private readonly options: ProviderOptions) {}

  query(input: QueryInput): AgentQuery {
    log(
      `query() called (cwd=${input.cwd}, continuation=${input.continuation ?? '<new>'}, ` +
        `prompt-len=${input.prompt.length})`,
    );

    // C-step2 TODO: instantiate CopilotClient, createSession/resumeSession
    // following the recovery layers in container/agent-runner-ghc/src/index.ts.
    // Translate session.on() callbacks into ProviderEvent yields:
    //   - session.idle               → { type: 'result', text: collectedText }
    //   - message.delta              → { type: 'activity' } + accumulate text
    //   - session.warning/error      → { type: 'progress', message } or
    //                                   { type: 'error', retryable: ... }
    //   - first session create/resume → { type: 'init', continuation: sessionId }
    //
    // Reference recovery semantics from session-recovery.ts:
    //   isSessionNotFoundError(err) → re-create session and retry once.

    return makeStubQuery(input);
  }

  /**
   * GHC SDK throws errors whose .message includes "Session not found" when
   * the in-memory active session map has evicted our session. We re-use the
   * existing classifier so behavior matches the GHC fork exactly.
   *
   * (Imported lazily to avoid pulling fork-side code into v2 build until
   * C-step2 finalizes the runtime layout.)
   */
  isSessionInvalid(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return /session\s*not\s*found/i.test(msg);
  }
}

/** Minimal stub query so the provider registers cleanly before C-step2. */
function makeStubQuery(_input: QueryInput): AgentQuery {
  const events = (async function* (): AsyncIterable<ProviderEvent> {
    yield {
      type: 'error',
      message:
        'copilot provider is C-step1 scaffold; SDK glue not yet implemented (C-step2)',
      retryable: false,
      classification: 'not-implemented',
    };
  })();
  return {
    push: () => {},
    end: () => {},
    abort: () => {},
    events,
  };
}

// Touch the imports so unused-import lint doesn't drop them before C-step2
// fills in the body. These symbols are the entire reason the file exists.
void CopilotClient;
void approveAll;

registerProvider('copilot', (options: ProviderOptions) => new CopilotAgentProvider(options));
registerProvider('github-copilot', (options: ProviderOptions) => new CopilotAgentProvider(options));
